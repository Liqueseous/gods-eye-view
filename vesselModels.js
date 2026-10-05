/**
 * @typedef {object} VesselModel
 * @property {string} aisType - The Autonomous Identification System (AIS) data type identifier.
 * @property {string} glbModelName - The name of the corresponding GLB model file.
 * @property {string} description - A brief description of the vessel type.
 */

/**
 * AIS type to GLB Model mapping.
 * @type {Map<string, VesselModel>}
 */
const vesselTypeToModelMap = new Map();

/**
 * Initializes the vessel type to model mapping.
 * @param {Array<VesselModel>} models - An array of vessel model objects.
 */
export function initializeVesselModels(models) {
  models.forEach(model => {
    vesselTypeToModelMap.set(model.aisType, model);
  });
}

/**
 * Retrieves the model information for a given AIS type.
 * @param {string} aisType - The AIS type to look up.
 * @returns {VesselModel | undefined} The vessel model or undefined if not found.
 */
export function getVesselModelByAisType(aisType) {
  return vesselTypeToModelMap.get(aisType);
}

// Example initialization (will be filled out based on AIS data):
// initializeVesselModels([
//   { aisType: "AIS_SHIP", glbModelName: "ship.glb", description: "General Ship" },
//   // ... other types
// ]);

export default vesselTypeToModelMap;