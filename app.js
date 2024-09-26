require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const Joi = require('joi');
const app = express();

const PORT = process.env.PORT || 3000; // Use Vercel's PORT or fallback to 3000

// Export the app for serverless deployment
module.exports = app;


// Middleware for parsing form data
app.use(express.urlencoded({ extended: true }));

// Setting view engine as EJS
app.set('view engine', 'ejs');

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MySQL
function connectToDatabase(db_name) {
    return mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: db_name
    });
}

// Input validation schema
const emailSchema = Joi.string().email();
const phoneSchema = Joi.string().pattern(/^\+?[\d\s\(\)-]{7,15}$/);
const web3Schema = Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/);

// Define where to search based on input type
const SEARCH_METADATA = {
    email: [
        { db_name: 'bigbasket', table_name: 'member_member', columns: ['email', 'email2'] },
        { db_name: 'instagram', table_name: 'instagram_user_data', columns: ['email'] },
        { db_name: 'chainlink', table_name: 'chainlink_users', columns: ['email'] },
        { db_name: 'boatdata', table_name: 'customer_address_combined', columns: ['email'] }
    ],
    phone: [
        { db_name: 'bigbasket', table_name: 'member_member', columns: ['mobile_no', 'phone_no2'] },
        { db_name: 'instagram', table_name: 'instagram_user_data', columns: ['phone'] },
        { db_name: 'boatdata', table_name: 'customer_address_combined', columns: ['cust_phone', 'addr_phone'] }
    ],
    web3_address: [
        { db_name: 'chainlink', table_name: 'chainlink_users', columns: ['web3_address'] }
    ]
};

// Identify the input type (email, phone, or web3 address)
function identifyAndValidateInput(inputValue) {
    if (emailSchema.validate(inputValue).error === undefined) return 'email';
    if (phoneSchema.validate(inputValue).error === undefined) return 'phone';
    if (web3Schema.validate(inputValue).error === undefined) return 'web3_address';
    return null;
}

// Search specific table for the input value
async function searchTable(db_name, table_name, column_names, inputValue) {
    const db = connectToDatabase(db_name);
    const [rows] = await db.promise().query(
        `SELECT * FROM ${table_name} WHERE ${column_names.map(col => `${col} = ?`).join(' OR ')}`,
        Array(column_names.length).fill(inputValue)
    );
    db.end();
    return rows.length ? rows[0] : null;
}

// Dynamically search related data
async function dynamicSearch(inputValue, processedEntries) {
    const inputType = identifyAndValidateInput(inputValue);
    if (!inputType) return [];

    const searchMetadata = SEARCH_METADATA[inputType] || [];
    let foundInfo = [];

    for (const entry of searchMetadata) {
        const { db_name, table_name, columns } = entry;

        if (processedEntries.has(db_name)) continue; // Skip if already processed

        const result = await searchTable(db_name, table_name, columns, inputValue);
        if (result) {
            foundInfo.push({ db_name, table_name, result });
            processedEntries.add(db_name);

            // Continue searching with found data
            for (const [key, value] of Object.entries(result)) {
                if (['email', 'email2', 'phone', 'mobile_no', 'mobile_no2', 'phone_no2', 'cust_phone', 'addr_phone', 'web3_address'].includes(key) && value && !processedEntries.has(value)) {
                    const additionalInfo = await dynamicSearch(value, processedEntries);
                    foundInfo = [...foundInfo, ...additionalInfo];
                }
            }
        }
    }
    return foundInfo;
}

// Log user query
async function logUserQuery(ip_address, user_agent, query) {
    const db = connectToDatabase('logging_db');
    await db.promise().query(
        'INSERT INTO user_queries (ip_address, user_agent, query) VALUES (?, ?, ?)',
        [ip_address, user_agent, query]
    );
    db.end();
}

// Main search function
async function performSearch(inputValue, ip_address, user_agent) {
    const processedEntries = new Set();
    const searchResults = await dynamicSearch(inputValue, processedEntries);
    await logUserQuery(ip_address, user_agent, inputValue);
    return searchResults;
}

// Route for index page
app.get('/', (req, res) => {
    res.render('index', { error_message: null });
});

// Handle search requests
app.post('/', async (req, res) => {
    try {
        const userInput = req.body.user_input;
        const ip_address = req.ip;
        const user_agent = req.headers['user-agent'];

        const inputType = identifyAndValidateInput(userInput);
        if (!inputType) {
            return res.render('index', { error_message: 'Invalid input. Please enter a valid email, phone number, or web3 address.' });
        }

        const foundInfo = await performSearch(userInput, ip_address, user_agent);
        res.render('results', { found_info: foundInfo, user_input: userInput });
    } catch (error) {
        console.error(error); // Log the error to Vercel logs
        res.status(500).send('Internal Server Error');
    }
});


// Query history route
app.get('/query_history', async (req, res) => {
    const db = connectToDatabase('logging_db');
    const [queryLogs] = await db.promise().query('SELECT * FROM user_queries ORDER BY timestamp DESC');
    db.end();
    res.render('query_history', { query_logs: queryLogs });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
