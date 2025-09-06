#!/usr/bin/env node
/**
 * DRONELINK LAUNCHER
 * Choose between different ways to run the Dronelink app locally
 */

const { spawn } = require('child_process');

console.log('🚁 DRONELINK LOCAL LAUNCHER');
console.log('===========================\n');

console.log('Choose how you want to run Dronelink:');
console.log('');
console.log('1. 🚀 ADVANCED PROFESSIONAL APP (Recommended)');
console.log('   → Professional UI matching Dronelink.com');
console.log('   → Advanced path curvature and Bezier curves');
console.log('   → Real-time altitude profiling charts');
console.log('   → Sophisticated mission statistics');
console.log('   → Multi-tab control panels');
console.log('   → URL: http://localhost:3001');
console.log('');
console.log('2. 🌐 BASIC FULL APP with UI and Interactive Map');
console.log('   → Complete Flutter-like interface');
console.log('   → Interactive mapping with Leaflet');
console.log('   → Mission planning and execution');
console.log('   → Real-time drone simulation');
console.log('   → URL: http://localhost:3000');
console.log('');
console.log('3. 🧪 API TESTING Interface');  
console.log('   → Function-by-function testing');
console.log('   → Navigation calculations');
console.log('   → Camera command testing');
console.log('   → Kernel analysis tools');
console.log('   → URL: http://localhost:8080');
console.log('');
console.log('4. 🚁 MISSION SIMULATOR (Console)');
console.log('   → Command-line mission execution');
console.log('   → Realistic flight simulation');
console.log('   → Battery and position tracking');
console.log('   → Console-based output');
console.log('');
console.log('5. 🔬 KERNEL RUNNER (Analysis)');
console.log('   → Direct kernel loading');
console.log('   → Dynamic analysis hooks');
console.log('   → Function call tracking');
console.log('   → Console-based analysis');
console.log('');
console.log('6. ⚡ DIRECT KERNEL ACCESS (No Auth Required!)');
console.log('   → Bypass all authentication');
console.log('   → Full offline mission planning');
console.log('   → Interactive mission builder');
console.log('   → Real-time path generation');
console.log('');
console.log('7. 🎨 VISUAL BYPASS INTERFACE (Recommended!)');
console.log('   → Full Dronelink UI without authentication');
console.log('   → Interactive map with click-to-add waypoints');
console.log('   → Real-time flight path visualization');
console.log('   → Professional mission planning experience');
console.log('');

// Get user choice
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

console.log('Press 1, 2, 3, 4, 5, 6, or 7 to choose (or ESC to exit):');

process.stdin.on('data', function (key) {
  const choice = key.toString();
  
  if (choice === '\u001b') { // ESC key
    console.log('\n👋 Goodbye!');
    process.exit(0);
  }
  
  let command, args, description;
  
  switch (choice) {
    case '1':
      command = 'node';
      args = ['advanced_dronelink_app.js'];
      description = 'Starting ADVANCED PROFESSIONAL APP...';
      break;
      
    case '2':
      command = 'node';
      args = ['dronelink_app_runner.js'];
      description = 'Starting BASIC FULL APP with UI and Map...';
      break;
      
    case '3':
      command = 'node';
      args = ['dronelink_web_interface.js'];
      description = 'Starting API TESTING Interface...';
      break;
      
    case '4':
      command = 'node';
      args = ['mission_simulator.js'];
      description = 'Starting MISSION SIMULATOR...';
      break;
      
    case '5':
      command = 'node';
      args = ['dronelink_runner.js'];
      description = 'Starting KERNEL RUNNER...';
      break;
      
    case '6':
      command = 'node';
      args = ['dronelink_direct_kernel.js'];
      description = 'Starting DIRECT KERNEL ACCESS...';
      break;
      
    case '7':
      command = 'node';
      args = ['dronelink_visual_bypass.js'];
      description = 'Starting VISUAL BYPASS INTERFACE...';
      break;
      
    default:
      console.log('Invalid choice. Press 1, 2, 3, 4, 5, 6, or 7.');
      return;
  }
  
  console.log(`\n🚀 ${description}`);
  console.log('Press Ctrl+C to stop the server when done.\n');
  
  // Restore normal stdin behavior
  process.stdin.setRawMode(false);
  process.stdin.pause();
  
  // Launch the chosen option
  const child = spawn(command, args, { 
    stdio: 'inherit',
    cwd: process.cwd()
  });
  
  child.on('error', (err) => {
    console.error('❌ Failed to start:', err.message);
  });
  
  child.on('close', (code) => {
    console.log(`\n✅ Process exited with code ${code}`);
  });
});