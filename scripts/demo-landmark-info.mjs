#!/usr/bin/env node
/**
 * Demo script for landmark history feature.
 * Shows both static and Wikipedia-based lookups.
 */

import { CITY_POIS } from '../src/locations.js';

console.log('='.repeat(60));
console.log('Landmark History & Explanation Demo');
console.log('='.repeat(60));
console.log();

// Demo 1: Show static historical data
console.log('📚 STATIC HISTORICAL DATA FROM CITY_POIS\n');

const landmarks = [
  { city: 'austin', index: 0 },    // Texas State Capitol
  { city: 'sf', index: 0 },        // Golden Gate Bridge
  { city: 'nyc', index: 0 },       // Statue of Liberty
  { city: 'paris', index: 0 },     // Eiffel Tower
  { city: 'dubai', index: 0 },     // Burj Khalifa
];

for (const { city, index } of landmarks) {
  const poi = CITY_POIS[city].pois[index];
  
  console.log(`🏛️  ${poi.name}`);
  console.log(`   City: ${CITY_POIS[city].name}`);
  console.log(`   Year: ${poi.yearBuilt || 'N/A'}`);
  console.log(`   Architect: ${poi.architect || 'N/A'}`);
  console.log(`   Style: ${poi.style || 'N/A'}`);
  console.log(`   Description: ${poi.description || 'No description'}`);
  console.log();
}

// Demo 2: Show coverage statistics
console.log('='.repeat(60));
console.log('📊 COVERAGE STATISTICS\n');

let totalPois = 0;
let poisWithHistory = 0;
const cityCoverage = {};

for (const [cityId, city] of Object.entries(CITY_POIS)) {
  let cityTotal = city.pois.length;
  let cityWithHistory = 0;
  
  for (const poi of city.pois) {
    totalPois++;
    if (poi.description || poi.history) {
      poisWithHistory++;
      cityWithHistory++;
    }
  }
  
  cityCoverage[cityId] = {
    name: city.name,
    coverage: `${cityWithHistory}/${cityTotal}`,
    percentage: Math.round((cityWithHistory / cityTotal) * 100),
  };
}

console.log(`Total POIs: ${totalPois}`);
console.log(`POIs with historical data: ${poisWithHistory}`);
console.log(`Coverage: ${Math.round((poisWithHistory / totalPois) * 100)}%\n`);

console.log('Coverage by city:');
for (const [cityId, stats] of Object.entries(cityCoverage)) {
  const bar = '█'.repeat(Math.floor(stats.percentage / 5));
  console.log(`  ${stats.name.padEnd(15)} ${stats.coverage.padEnd(6)} ${bar} ${stats.percentage}%`);
}

console.log();
console.log('='.repeat(60));
console.log('🌐 WIKIPEDIA FALLBACK\n');
console.log('For landmarks not in CITY_POIS, the system automatically');
console.log('fetches information from Wikipedia. Try asking about:');
console.log('  - "Tell me about the Colosseum"');
console.log('  - "What is Big Ben?"');
console.log('  - "Explain the Taj Mahal"');
console.log();

console.log('='.repeat(60));
console.log('🎤 VOICE COMMAND EXAMPLES\n');
console.log('When using voice control, try these queries:');
console.log('  1. "What am I looking at?"');
console.log('     → Identifies nearest landmark with brief description');
console.log();
console.log('  2. "Tell me about the Golden Gate Bridge"');
console.log('     → Full historical context and interesting facts');
console.log();
console.log('  3. "Explain this building"');
console.log('     → Details about the building in current view');
console.log();
console.log('  4. "What\'s the history here?"');
console.log('     → Historical information about current location');
console.log();

console.log('='.repeat(60));
console.log('✅ Feature successfully implemented!');
console.log('Run tests: node --test src/voice/landmarkInfo.test.mjs');
console.log('Documentation: docs/LANDMARK-HISTORY.md');
console.log('='.repeat(60));
