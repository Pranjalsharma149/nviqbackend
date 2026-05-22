'use strict';

/**
 * 4G API Connectivity Diagnostic
 * 
 * Run this to test if 192.168.10.1/webservice is reachable
 * Command: node 4g-api-diagnostic.js
 */

const axios = require('axios');
const http = require('http');
const net = require('net');

const CONFIG = {
  baseUrl: process.env['4G_API_BASE_URL'] || 'http://192.168.10.1/webservice',
  username: process.env['4G_API_USERNAME'] || 'abc@test.com',
  password: process.env['4G_API_PASSWORD'] || 'xyx@453',
  timeout: 5000,
};

console.log('\n' + '='.repeat(70));
console.log('4G API CONNECTIVITY DIAGNOSTIC');
console.log('='.repeat(70) + '\n');

console.log('Configuration:');
console.log('  Server:', CONFIG.baseUrl);
console.log('  Username:', CONFIG.username);
console.log('  Timeout:', CONFIG.timeout + 'ms\n');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: DNS Resolution
// ─────────────────────────────────────────────────────────────────────────────
async function testDNS() {
  return new Promise((resolve) => {
    console.log('TEST 1: DNS Resolution');
    console.log('─'.repeat(70));

    const url = new URL(CONFIG.baseUrl);
    const hostname = url.hostname;

    console.log('  Resolving hostname:', hostname);

    const dns = require('dns');
    dns.lookup(hostname, (err, address, family) => {
      if (err) {
        console.log('  ❌ FAILED:', err.message);
        console.log('  → Server hostname cannot be resolved');
        console.log('  → Check if 192.168.10.1 is correct\n');
        resolve(false);
      } else {
        console.log('  ✅ RESOLVED:', hostname, '→', address);
        console.log('  → Hostname resolution successful\n');
        resolve(true);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: TCP Connection
// ─────────────────────────────────────────────────────────────────────────────
async function testTCP() {
  return new Promise((resolve) => {
    console.log('TEST 2: TCP Connection (Port 80)');
    console.log('─'.repeat(70));

    const url = new URL(CONFIG.baseUrl);
    const host = url.hostname;
    const port = url.port || 80;

    console.log(`  Attempting to connect to ${host}:${port}`);

    const socket = new net.Socket();
    socket.setTimeout(CONFIG.timeout);

    socket.on('connect', () => {
      console.log(`  ✅ CONNECTED: TCP connection successful`);
      console.log('  → Server is reachable\n');
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      console.log('  ❌ TIMEOUT: Connection timed out');
      console.log('  → Server not responding to TCP connection');
      console.log('  → Check firewall/network access\n');
      socket.destroy();
      resolve(false);
    });

    socket.on('error', (err) => {
      console.log('  ❌ ERROR:', err.message);
      if (err.code === 'ECONNREFUSED') {
        console.log('  → Connection refused (server not running or port wrong)');
      } else if (err.code === 'EHOSTUNREACH') {
        console.log('  → Host unreachable (network/routing issue)');
      } else if (err.code === 'ENETUNREACH') {
        console.log('  → Network unreachable (not on correct network)');
      }
      console.log('  → Make sure you\'re connected to the company network\n');
      resolve(false);
    });

    socket.connect(port, host);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: HTTP Request
// ─────────────────────────────────────────────────────────────────────────────
async function testHTTP() {
  console.log('TEST 3: HTTP Request (GET)');
  console.log('─'.repeat(70));
  console.log('  Testing basic HTTP connectivity...\n');

  try {
    const response = await axios.get(CONFIG.baseUrl, {
      timeout: CONFIG.timeout,
      validateStatus: () => true,  // Accept any status code
    });

    console.log('  ✅ HTTP Request successful');
    console.log('  Status Code:', response.status);
    console.log('  → Server is responding to HTTP requests\n');
    return true;

  } catch (error) {
    console.log('  ❌ HTTP Request failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('  → Connection refused');
    } else if (error.code === 'ENOTFOUND') {
      console.log('  → Host not found (DNS issue)');
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      console.log('  → Connection timeout (server slow or unreachable)');
    }
    console.log('  → This confirms the server is not reachable\n');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Token Generation
// ─────────────────────────────────────────────────────────────────────────────
async function testToken() {
  console.log('TEST 4: Token Generation (API Call)');
  console.log('─'.repeat(70));
  console.log('  Attempting to generate 4G API token...\n');

  try {
    const response = await axios.post(
      `${CONFIG.baseUrl}?token=generateAccessToken`,
      {
        username: CONFIG.username,
        password: CONFIG.password,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: CONFIG.timeout,
      }
    );

    if (response.data?.result === 1 && response.data?.data?.token) {
      console.log('  ✅ TOKEN GENERATED successfully');
      console.log('  Token (first 50 chars):', response.data.data.token.substring(0, 50) + '...');
      console.log('  → 4G API is fully functional!\n');
      return true;
    } else {
      console.log('  ⚠️  API responded but invalid token format');
      console.log('  Response:', JSON.stringify(response.data, null, 2));
      console.log('  → Server is reachable but response is wrong\n');
      return false;
    }

  } catch (error) {
    console.log('  ❌ Token generation failed:', error.message);
    if (error.response) {
      console.log('  Status:', error.response.status);
      console.log('  Data:', error.response.data);
    }
    console.log('  → Cannot generate token\n');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Network Info
// ─────────────────────────────────────────────────────────────────────────────
function printNetworkInfo() {
  const os = require('os');
  console.log('NETWORK INFORMATION');
  console.log('─'.repeat(70));

  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    addrs.forEach((addr) => {
      if (addr.family === 'IPv4') {
        console.log(`  ${name}: ${addr.address}`);
      }
    });
  }

  console.log('\n  Current network interfaces above ↑');
  console.log('  Is 192.168.10.x in the list? If NO → Not on company network\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Diagnostic
// ─────────────────────────────────────────────────────────────────────────────
async function runDiagnostics() {
  try {
    const test1 = await testDNS();
    const test2 = await testTCP();
    const test3 = await testHTTP();
    const test4 = test3 ? await testToken() : false;

    printNetworkInfo();

    // Summary
    console.log('SUMMARY');
    console.log('='.repeat(70));

    const results = [
      { name: 'DNS Resolution', passed: test1 },
      { name: 'TCP Connection', passed: test2 },
      { name: 'HTTP Request', passed: test3 },
      { name: 'Token Generation', passed: test4 },
    ];

    results.forEach(r => {
      const status = r.passed ? '✅' : '❌';
      console.log(`  ${status} ${r.name}`);
    });

    const allPassed = results.every(r => r.passed);

    console.log('\n' + '─'.repeat(70));

    if (allPassed) {
      console.log('✅ ALL TESTS PASSED - 4G API is fully operational!');
      console.log('\nNext steps:');
      console.log('  1. Set 4G_API_ENABLED=true in .env');
      console.log('  2. Restart backend: npm run dev');
      console.log('  3. 4G API poller should now work\n');

    } else if (test2) {
      console.log('⚠️  SERVER IS REACHABLE but something is wrong');
      console.log('\nPossible issues:');
      console.log('  • Wrong credentials in .env');
      console.log('  • Server is busy or slow');
      console.log('  • API endpoint has changed');
      console.log('\nNext steps:');
      console.log('  1. Verify username/password in .env');
      console.log('  2. Test manually with curl:');
      console.log(`     curl -X POST "${CONFIG.baseUrl}?token=generateAccessToken" \\`);
      console.log('       -H "Content-Type: application/json" \\');
      console.log(`       -d '{"username":"${CONFIG.username}","password":"${CONFIG.password}'}\n`);

    } else if (test1) {
      console.log('⚠️  SERVER FOUND but NOT REACHABLE (TCP connection failed)');
      console.log('\nPossible issues:');
      console.log('  • Server is offline');
      console.log('  • Firewall is blocking port 80');
      console.log('  • Wrong IP address');
      console.log('  • Not connected to company network\n');

    } else {
      console.log('❌ SERVER NOT FOUND (DNS resolution failed)');
      console.log('\nPossible issues:');
      console.log('  • Wrong IP address (192.168.10.1)');
      console.log('  • Not connected to company network');
      console.log('  • Network configuration issue\n');
      console.log('SOLUTION:');
      console.log('  For now, disable 4G API in .env:');
      console.log('  4G_API_ENABLED=false');
    }

    console.log('='.repeat(70) + '\n');

  } catch (err) {
    console.error('Fatal error:', err.message);
  }
}

// Run diagnostics
runDiagnostics().catch(console.error);