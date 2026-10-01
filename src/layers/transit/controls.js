/**
 * Manager wiring. Transit's data arrives from camera-driven proximity polls,
 * not only from the manager's own tick, so the layer keeps a handle it can use
 * to repaint its panel row the moment a snapshot lands.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts }) {
  const methods = {
    /**
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      state._dataManager = dataManager;
    },

    /**
     * Runtime params (DataLayerManager.setLayerParams path).
     * routes: whether route-line geometry draws at all (still subject to the
     * altitude gate when true).
     * @param {{routes?: boolean}} [params]
     */
    setParams(params = {}) {
      if (params.routes !== undefined) {
        state._params.routes = params.routes !== false;
        parts.viewport?.runProximityCheck();
        state._rowControlsListener?.();
      }
      return true;
    },

    /** @returns {{routes: boolean}} Current runtime params. */
    getParams() {
      return { routes: state._params.routes !== false };
    },

    /**
     * Layer-row sub-control (DataLayerManager row-controls contract): a ROUTES
     * chip toggling route-line geometry independent of the altitude gate.
     * @returns {{chips: Array<object>}} Row controls.
     */
    getRowControls() {
      const active = state._params.routes !== false;
      return {
        chips: [
          {
            id: 'routes',
            label: 'ROUTES',
            active,
            title: active
              ? 'Hide transit route lines'
              : 'Show transit route lines (below the altitude gate)',
            params: { routes: !active },
          },
        ],
      };
    },

    /**
     * Install the manager's "row controls changed" callback.
     * @param {(() => void)|null} listener Callback, or null to detach.
     */
    setRowControlsListener(listener) {
      state._rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },
  };
  return { methods };
}
