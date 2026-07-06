const noopBreaker = {
  getStatus: () => ({ state: "CLOSED" }),
  reset: () => {},
  recordFailure: () => {},
  recordSuccess: () => {}
};
export const getAllCircuitBreakerStatuses = () => [],
  getCircuitBreaker = () => noopBreaker;
const _defaultExport = {};
export default _defaultExport;