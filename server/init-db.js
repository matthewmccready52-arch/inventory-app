const fs = require('fs');
const path = require('path');
const db = require('./db');

const schemaPath = path.resolve(__dirname, '../database/schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

db.exec(schema, (err) => {
  if (err) {
    console.error('Database init failed:', err.message);
    process.exit(1);
  }
  console.log('Database initialized successfully.');
  process.exit(0);
});