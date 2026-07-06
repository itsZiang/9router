const requestRegistry = new Map();
const responseRegistry = new Map();
function makeKey(from, to) {
  return `${from}:${to}`;
}
export function register(from, to, requestFn, responseFn) {
  const key = makeKey(from, to);
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}
export function getRequestTranslator(from, to) {
  return requestRegistry.get(makeKey(from, to));
}
export function getResponseTranslator(from, to) {
  return responseRegistry.get(makeKey(from, to));
}