#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'dji-controller-interface', 'src', 'agent', 'agent_capability_manifest.json');
const target = path.join(projectRoot, 'docs', 'agent_capability_manifest.json');

try {
  const raw = fs.readFileSync(source, 'utf8');
  fs.writeFileSync(target, raw + (raw.endsWith('\n') ? '' : '\n'), 'utf8');
  console.log(`Capability manifest copied to ${path.relative(projectRoot, target)}`);
} catch (error) {
  console.error('Failed to update capability manifest:', error.message);
  process.exitCode = 1;
}
