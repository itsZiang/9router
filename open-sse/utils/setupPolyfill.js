// Polyfill worker_threads.markAsUncloneable for Node.js < 21 compatibility (specifically Node 20.20.2)
import worker_threads from "node:worker_threads";
import { WebSocket } from "ws";
if (worker_threads && !worker_threads.markAsUncloneable) {
  worker_threads.markAsUncloneable = function (obj) {
    if (worker_threads.markAsUntransferable) {
      try {
        worker_threads.markAsUntransferable(obj);
      } catch {
        // no-op
      }
    }
  };
}

// Polyfill Promise.withResolvers for Node.js < 22 compatibility (specifically Node 20.20.2)
if (typeof Promise.withResolvers === "undefined") {
  Promise.withResolvers = function () {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      promise,
      resolve,
      reject
    };
  };
}

// Polyfill WebSocket for Node.js < 22 compatibility (specifically Node 20.20.2)
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket;
}