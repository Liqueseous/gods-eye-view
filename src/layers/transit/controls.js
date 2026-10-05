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
     * altitude gate when true). placards: whether station placards draw.
     * @param {{routes?: boolean, placards?: boolean}} [params]
     */
    setParams(params = {}) {
      let changed = false;
      if (params.routes !== undefined) {
        state._params.routes = params.routes !== false;
        parts.viewport?.syncRouteVisibility?.();
        parts.viewport?.runProximityCheck();
        changed = true;
      }
      if (params.placards !== undefined) {
        state._params.placards = params.placards !== false;
        parts.routes?.setStationPlacardsVisible?.(state._params.placards);
        changed = true;
      }
      if (changed) {
        state._rowControlsListener?.();
        if (typeof document !== 'undefined')
          document.dispatchEvent(
            new CustomEvent('gev:transit-params-changed', {
              detail: {
                routes: state._params.routes !== false,
                placards: state._params.placards !== false,
              },
            }),
          );
      }
      return true;
    },

    /** @returns {{routes: boolean, placards: boolean}} Current runtime params. */
    getParams() {
      return {
        routes: state._params.routes !== false,
        placards: state._params.placards !== false,
      };
    },

    /**
     * Layer-row sub-controls (DataLayerManager row-controls contract).
     * Station placards require visible routes, so their chip is unavailable
     * until ROUTES is enabled.
     * @returns {{chips: Array<object>}} Row controls.
     */
    getRowControls() {
      const routesActive = state._params.routes !== false;
      const placardsActive = state._params.placards !== false;
      return {
        chips: [
          {
            id: 'routes',
            label: 'ROUTES',
            active: routesActive,
            title: routesActive
              ? 'Hide transit route lines'
              : 'Show transit route lines (below the altitude gate)',
            params: { routes: !routesActive },
          },
          {
            id: 'placards',
            label: 'PLACARDS',
            active: placardsActive,
            state: routesActive ? undefined : 'disabled',
            disabled: !routesActive,
            title: !routesActive
              ? 'Enable transit route lines to show station placards'
              : placardsActive
                ? 'Hide station placards'
                : 'Show station placards',
            params: { placards: !placardsActive },
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
