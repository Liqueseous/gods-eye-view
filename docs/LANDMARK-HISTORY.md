# Landmark History & Explanation Feature

## Overview

The landmark history feature provides rich historical context and descriptions for landmarks visible in God's Eye View. It uses a hybrid approach combining curated static data with dynamic Wikipedia lookups.

## Features

### 1. **Static Historical Data**
Curated information for major landmarks in CITY_POIS:
- **Description**: Brief summary of the landmark
- **History**: Detailed historical context including construction, significance, and facts
- **Year Built**: Construction completion year
- **Architect**: Designer(s) and architects
- **Style**: Architectural style

### 2. **Dynamic Wikipedia Integration**
For landmarks not in the curated database:
- Fetches summaries from Wikipedia REST API
- 1-hour cache to minimize API calls
- Includes extract, description, URL, and thumbnail

### 3. **Voice Control Integration**
Natural voice queries:
- "What is this?" / "What am I looking at?"
- "Tell me about [landmark name]"
- "Explain the Golden Gate Bridge"
- "What's the history of the Eiffel Tower?"

## Architecture

### Data Flow
```
User Query
    ↓
Voice Instructions (instructions.js)
    ↓
get_landmark_info tool
    ↓
getLandmarkInformation (gevActions.js)
    ↓
    ├─→ CITY_POIS (static) → Return curated data
    └─→ Wikipedia API (dynamic) → Return Wikipedia summary
```

### Files Modified/Created

**Core Data:**
- `src/locations.js` - Extended CITY_POIS with historical metadata

**Wikipedia Service:**
- `server/providers/wikipedia/wikipedia.js` - Wikipedia API integration
- `server/providers/wikipedia/wikipedia.test.mjs` - Tests

**Voice System:**
- `src/voice/gevActions.js` - Added getLandmarkInformation handler
- `src/voice/actionSchemas.js` - Added get_landmark_info schema
- `server/providers/openai/toolDescriptions.js` - Tool description
- `server/providers/openai/instructions.js` - Updated voice instructions
- `server/providers/openai.js` - Wired Wikipedia endpoint

**Tests:**
- `src/voice/landmarkInfo.test.mjs` - Historical data validation

## Usage Examples

### Voice Queries

**Identifying current view:**
```
User: "What am I looking at?"
Assistant: "The Golden Gate Bridge, completed in 1937"
```

**Detailed explanation:**
```
User: "Tell me about the Eiffel Tower"
Assistant: [Calls get_landmark_info]
"The Eiffel Tower is an iconic wrought-iron lattice tower and 
symbol of Paris. Built for the 1889 World's Fair, it was designed 
by Gustave Eiffel's company. At 1,083 feet, it was the world's 
tallest structure until 1930..."
```

**Wikipedia fallback:**
```
User: "What is the Colosseum?"
Assistant: [Fetches from Wikipedia]
"The Colosseum is an ancient amphitheatre in Rome..."
```

### Programmatic Access

**Check if landmark has historical data:**
```javascript
const poi = CITY_POIS.sf.pois[0]; // Golden Gate Bridge
if (poi.description || poi.history) {
  console.log(poi.history);
}
```

**Fetch landmark info manually:**
```javascript
const result = await getLandmarkInformation({
  name: 'Golden Gate Bridge',
  cityId: 'sf'
}, placeSearch);

if (result.ok) {
  console.log(result.source); // 'static' or 'wikipedia'
  console.log(result.description);
  console.log(result.history);
}
```

## Adding New Landmarks

### Static Data (Preferred for Major Landmarks)

Edit `src/locations.js` and add metadata to any POI:

```javascript
{
  name: 'Landmark Name',
  lat: 37.8199,
  lon: -122.4783,
  alt: 1400,
  pitch: -20,
  heading: 45,
  buildingHeight: 100,
  // ADD THESE:
  description: 'Brief one-line summary',
  history: 'Detailed historical context with facts, dates, and significance',
  yearBuilt: 1937,
  architect: 'Architect Name(s)',
  style: 'Architectural Style',
}
```

### Guidelines
- **Description**: 1-2 sentences, present tense
- **History**: 2-4 sentences with key facts, dates, and significance
- **Style**: Use established architectural terms (Art Deco, Gothic, Modernist, etc.)

### Current Coverage
Major landmarks with historical data:
- **Austin**: Texas State Capitol (1888)
- **San Francisco**: Golden Gate Bridge (1937), Transamerica Pyramid (1972)
- **New York**: Statue of Liberty (1886), Empire State Building (1931)
- **Paris**: Eiffel Tower (1889)
- **Dubai**: Burj Khalifa (2010)
- **Washington DC**: US Capitol (1800), Washington Monument (1884)
- **Tokyo**: Tokyo Tower (1958)
- **London**: Tower Bridge (1894)

## API Reference

### Voice Tool: `get_landmark_info`

**Parameters:**
- `name` (required): Landmark name to look up
- `cityId` (optional): City ID if landmark is in CITY_POIS

**Returns:**
```javascript
{
  ok: true,
  action: 'get_landmark_info',
  source: 'static' | 'wikipedia',
  name: string,
  description: string,
  history: string,        // static only
  extract: string,        // wikipedia only
  yearBuilt: number,      // static only
  architect: string,      // static only
  style: string,          // static only
  url: string,            // wikipedia only
  thumbnail: string,      // wikipedia only
  city: string,           // static only
  coordinates: object     // static only
}
```

### Server Endpoint: `/api/wikipedia/summary`

**GET** `/api/wikipedia/summary?name=<landmark>`

**Response:**
```javascript
{
  ok: true,
  extract: string,
  url: string,
  description: string,
  thumbnail: string
}
```

## Performance

### Caching
- **Wikipedia**: 1-hour in-memory cache
- **Static data**: Instant, no network calls

### Rate Limiting
- No explicit rate limiting on Wikipedia API
- Cache minimizes repeated calls
- Consider adding rate limits if high volume

## Testing

Run tests:
```bash
# Static historical data tests
node --test src/voice/landmarkInfo.test.mjs

# Wikipedia service tests
node --test server/providers/wikipedia/wikipedia.test.mjs
```

## Future Enhancements

### Potential Additions
1. **Images**: Include landmark photos in responses
2. **Related landmarks**: Suggest nearby points of interest
3. **Historical events**: Major events that occurred at the landmark
4. **Visitor info**: Hours, tickets, accessibility
5. **Multiple languages**: Wikipedia supports many languages
6. **User contributions**: Allow users to submit landmark data
7. **Local database**: SQLite cache for offline operation

### Integration Opportunities
1. **Analyst agent**: Query historical landmarks by criteria
2. **Annotation tooltips**: Show brief history on hover
3. **Tour mode**: Guided historical tours of cities
4. **Timeline view**: Show landmarks by construction date

## Troubleshooting

### Wikipedia API Fails
- Check network connectivity
- Verify landmark name spelling
- Try alternative names (e.g., "Big Ben" vs "Elizabeth Tower")

### Empty Results
- Landmark may not have Wikipedia article in English
- Try adding landmark to CITY_POIS with static data

### Outdated Information
- Wikipedia cache TTL is 1 hour
- Clear cache: call `clearWikipediaCache()` in browser console
- Update static data in locations.js for permanent fixes

## References

- **Wikipedia REST API**: https://en.wikipedia.org/api/rest_v1/
- **CITY_POIS**: `src/locations.js`
- **Voice Instructions**: `server/providers/openai/instructions.js`
