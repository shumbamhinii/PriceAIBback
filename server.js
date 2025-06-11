// Remove this line if you are no longer using any environment variables from a .env file.
// If PORT is still needed from .env, keep it. But for the DB connection, it's removed.
// require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const xlsx = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000; // PORT can still come from environment variable

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Enable parsing of JSON request bodies

// HARDCODED PostgreSQL connection string
// WARNING: This is NOT recommended for production environments due to security risks.
// Environment variables are the preferred and secure way to manage database credentials.
const connectionString = "postgresql://priceai_user:rKaX0aMlhf0x2EWHyG92KiM3XGPsUqxS@dpg-d14id43uibrs73ag1gg0-a.oregon-postgres.render.com/priceai";

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    // This is often required for connecting to Render PostgreSQL from outside Render's internal network.
    // In a production setup, you might configure specific SSL certificate validation
    // rather than rejecting unauthorized, but for direct hardcoding this often enables the connection.
    rejectUnauthorized: false
  }
});

// --- Helper functions for validation (moved to top for clarity) ---
const isValidNumber = (value) => typeof value === 'number' && !isNaN(value) && isFinite(value);
// Profit margin should be less than 100% to avoid division by zero or negative target revenue
const isValidProfitPercentage = (value) => isValidNumber(value) && value >= 0 && value < 100;
const isValidPositiveNumber = (value) => isValidNumber(value) && value > 0;
const isValidPositiveInteger = (value) => Number.isInteger(value) && value > 0;


// --- Helper to extract "Cost Per Unit After Operating Costs" from Excel sheet JSON rows ---
function extractCostPerUnit(dataRows) {
    for (const row of dataRows) {
        const keys = Object.keys(row);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const cellValue = row[key];
            if (
                typeof cellValue === 'string' &&
                cellValue.trim().toLowerCase() === 'cost per unit after operating costs'
            ) {
                // The value is two columns to the right of this key
                const targetIndex = i + 2;
                if (targetIndex < keys.length) {
                    const targetValue = row[keys[targetIndex]];
                    const numVal = parseFloat(targetValue);
                    return isNaN(numVal) ? targetValue : numVal;
                }
            }
        }
    }
    return null;
}

// --- Existing Route: Get pricing data and cost per unit from Excel by sheet name ---
app.get('/pricing-data/:sheet', (req, res) => {
    const sheetName = req.params.sheet;

    try {
        const filePath = path.join(__dirname, 'pricing_data.xlsx');
        const workbook = xlsx.readFile(filePath);
        const worksheet = workbook.Sheets[sheetName];

        if (!worksheet) {
            return res.status(404).json({
                success: false,
                message: `Sheet '${sheetName}' not found in the Excel file.`,
            });
        }

        // Convert worksheet to JSON, defval: null to keep empty cells
        const data = xlsx.utils.sheet_to_json(worksheet, { defval: null });

        // Extract the cost per unit after operating costs
        const costPerUnit = extractCostPerUnit(data);

        res.json({
            success: true,
            data,
            costPerUnit,
        });
    } catch (error) {
        console.error('Error reading pricing data:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server error reading Excel file.',
        });
    }
});

//

//New Pricing Calculation Endpoint

//This new `POST` endpoint handles the core logic for calculating product prices based on your monthly fixed costs, desired profit margin, and individual product contributions.
//javascript
// --- New Route: Calculate Prices ---
app.post('/api/calculate-prices', (req, res) => {
    const { totalMonthlyCost, profitPercentage, products } = req.body;

    // --- Server-Side Validation ---
    if (!isValidPositiveNumber(totalMonthlyCost)) {
        return res.status(400).json({ success: false, message: 'Total Monthly Cost must be a valid positive number.' });
    }
    if (!isValidProfitPercentage(profitPercentage)) {
        return res.status(400).json({ success: false, message: 'Desired Profit Percentage must be a number between 0 and 99.99.' });
    }
    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one product must be provided.' });
    }

    let totalRevenuePercentage = 0;
    for (const product of products) {
        // Ensure product properties exist and are valid
        if (typeof product.name !== 'string' || product.name.trim() === '') {
            return res.status(400).json({ success: false, message: `Product name cannot be empty for one of the products.` });
        }
        if (!isValidPositiveNumber(product.revenuePercentage) || product.revenuePercentage > 100) {
            return res.status(400).json({ success: false, message: `Revenue Percentage for "${product.name}" must be a valid positive number up to 100%.` });
        }
        if (!isValidPositiveInteger(product.expectedSalesVolume)) {
            return res.status(400).json({ success: false, message: `Expected Sales Volume for "${product.name}" must be a valid positive integer.` });
        }
        totalRevenuePercentage += product.revenuePercentage;
    }

    // Check if total product revenue percentages sum to 100% (allowing for slight floating point inaccuracies)
    if (Math.abs(totalRevenuePercentage - 100) > 0.01) {
        return res.status(400).json({ success: false, message: `All product revenue percentages must sum up to 100%. Current total: ${totalRevenuePercentage.toFixed(2)}%.` });
    }

    // --- Core Pricing Calculations ---
    try {
        // Calculate the total revenue needed to cover costs and achieve the desired profit margin
        // Formula: Total_Revenue = Total_Cost / (1 - Profit_Margin_Percentage_as_Decimal)
        const targetTotalRevenue = totalMonthlyCost / (1 - profitPercentage / 100);

        const calculatedProducts = products.map(product => {
            // Calculate the revenue target for each individual product based on its percentage contribution
            const individualProductRevenueTarget = targetTotalRevenue * (product.revenuePercentage / 100);

            // Calculate the price per unit for each product
            const individualProductPricePerUnit = individualProductRevenueTarget / product.expectedSalesVolume;

            return {
                ...product, // Include original product data for context
                individualRevenueTarget: parseFloat(individualProductRevenueTarget.toFixed(2)),
                calculatedPricePerUnit: parseFloat(individualProductPricePerUnit.toFixed(2))
            };
        });

        // --- Send Success Response ---
        res.status(200).json({
            success: true,
            data: {
                targetTotalRevenue: parseFloat(targetTotalRevenue.toFixed(2)),
                calculatedProducts
            },
            message: 'Prices calculated successfully.'
        });

    } catch (error) {
        console.error('Backend calculation error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred during calculation.' });
    }
});
app.post('/api/snapshots', async (req, res) => {
    const { name, total_cost, use_margin, target_profit, target_margin, use_breakdown, products, expenses } = req.body;

    if (!name || !total_cost || !Array.isArray(products)) {
        return res.status(400).json({ message: 'Missing required snapshot data' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Insert into snapshots
        const snapshotRes = await client.query(`
            INSERT INTO tbs.snapshots (name, total_cost, use_margin, target_profit, target_margin, use_breakdown)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [name, total_cost, use_margin, target_profit, target_margin, use_breakdown]);

        const snapshotId = snapshotRes.rows[0].id;

        // Insert products
        for (const product of products) {
            const { name, revenue_percentage, expected_units, cost_per_unit } = product;
            await client.query(`
                INSERT INTO tbs.products (snapshot_id, name, revenue_percentage, expected_units, cost_per_unit)
                VALUES ($1, $2, $3, $4, $5)
            `, [snapshotId, name, revenue_percentage, expected_units, cost_per_unit]);
        }

        // Insert expenses (if any)
        if (Array.isArray(expenses)) {
            for (const expense of expenses) {
                const { label, amount } = expense;
                await client.query(`
                    INSERT INTO tbs.expenses (snapshot_id, label, amount)
                    VALUES ($1, $2, $3)
                `, [snapshotId, label, amount]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, snapshotId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Snapshot save error:', err.message);
        res.status(500).json({ success: false, message: 'Error saving snapshot' });
    } finally {
        client.release();
    }
});
app.get('/api/snapshots', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, created_at FROM tbs.snapshots ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching snapshots:', err.message);
        res.status(500).send('Server error');
    }
});
app.get('/api/snapshots/:id', async (req, res) => {
    const snapshotId = req.params.id;

    try {
        const { rows: snapshots } = await pool.query(`
            SELECT * FROM tbs.snapshots WHERE id = $1
        `, [snapshotId]);

        if (snapshots.length === 0) {
            return res.status(404).json({ message: 'Snapshot not found' });
        }

        const { rows: products } = await pool.query(`
            SELECT * FROM tbs.products WHERE snapshot_id = $1
        `, [snapshotId]);

        const { rows: expenses } = await pool.query(`
            SELECT * FROM tbs.expenses WHERE snapshot_id = $1
        `, [snapshotId]);

        res.json({
            snapshot: snapshots[0],
            products,
            expenses
        });

    } catch (err) {
        console.error('Error loading snapshot:', err.message);
        res.status(500).send('Server error');
    }
});
app.get('/api/master-products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tbs.master_products ORDER BY name');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Error fetching master products:', err.message);
        res.status(500).json({ success: false, message: 'Server error fetching master products.' });
    }
});
app.post('/api/master-products', async (req, res) => {
    const { name, default_cost_per_unit, default_expected_units, default_revenue_percentage } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ success: false, message: 'Product name is required.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO tbs.master_products (name, default_cost_per_unit, default_expected_units, default_revenue_percentage)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [name.trim(), default_cost_per_unit, default_expected_units, default_revenue_percentage]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Error inserting master product:', err.message);
        res.status(500).json({ success: false, message: 'Failed to create master product.' });
    }
});


// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
