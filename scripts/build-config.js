#!/usr/bin/env node
/**
 * Build script to generate public/config.js from environment variables.
 * Run this before deploying: node scripts/build-config.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read environment variables from .env file if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

// Validate required environment variables
const required = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'ORGANISATION_NAME',
  'EMAIL_DOMAIN',
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error(`Create a .env file in the project root. See .env.example for the template.`);
  process.exit(1);
}

// Generate config.js
const configContent = `// Supabase project config. These values are public-safe (publishable key only).
// Do NOT put the service-role key here.
// This file is generated from .env variables during build.
window.SUPABASE_CONFIG = {
  url: '${process.env.SUPABASE_URL}',
  publishableKey: '${process.env.SUPABASE_PUBLISHABLE_KEY}',
};

// Local UI defaults. Keep these aligned with the rows in public.settings.
window.APP_CONFIG = {
  title: 'Focus Group Scheduler',
  organisationName: '${process.env.ORGANISATION_NAME}',
  emailDomain: '${process.env.EMAIL_DOMAIN}',
  defaultLocation: '${process.env.DEFAULT_LOCATION || 'To be confirmed'}',
};
`;

const configPath = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(configPath, configContent);
console.log(`✅ Generated ${configPath}`);
