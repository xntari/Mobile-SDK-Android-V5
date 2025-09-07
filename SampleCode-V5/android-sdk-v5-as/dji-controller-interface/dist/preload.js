/*
 * ATTENTION: The "eval" devtool has been used (maybe by default in mode: "development").
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/preload.ts":
/*!************************!*\
  !*** ./src/preload.ts ***!
  \************************/
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

eval("{\nObject.defineProperty(exports, \"__esModule\", ({ value: true }));\nconst electron_1 = __webpack_require__(/*! electron */ \"electron\");\n// Expose protected methods that allow the renderer process to use\n// the ipcRenderer without exposing the entire object\nelectron_1.contextBridge.exposeInMainWorld('electronAPI', {\n    // Window controls\n    minimizeWindow: () => electron_1.ipcRenderer.invoke('window-minimize'),\n    maximizeWindow: () => electron_1.ipcRenderer.invoke('window-maximize'),\n    closeWindow: () => electron_1.ipcRenderer.invoke('window-close'),\n    // Bridge communication\n    sendBridgeCommand: (command) => electron_1.ipcRenderer.invoke('send-bridge-command', command),\n    getConnectionStatus: () => electron_1.ipcRenderer.invoke('get-connection-status'),\n    // Event listeners\n    onBridgeData: (callback) => {\n        electron_1.ipcRenderer.on('bridge-data', (event, data) => callback(data));\n    },\n    onVideoFrame: (callback) => {\n        electron_1.ipcRenderer.on('video-frame', (event, frame) => callback(frame));\n    },\n    onFPVVideoFrame: (callback) => {\n        electron_1.ipcRenderer.on('fpv-video-frame', (event, frame) => callback(frame));\n    },\n    onSecondaryVideoFrame: (callback) => {\n        electron_1.ipcRenderer.on('secondary-video-frame', (event, frame) => callback(frame));\n    },\n    onConnectionStatus: (callback) => {\n        electron_1.ipcRenderer.on('connection-status', (event, status) => callback(status));\n    },\n    // Cleanup listeners\n    removeAllListeners: (channel) => {\n        electron_1.ipcRenderer.removeAllListeners(channel);\n    }\n});\n\n\n//# sourceURL=webpack://dji-controller-interface/./src/preload.ts?\n}");

/***/ }),

/***/ "electron":
/*!***************************!*\
  !*** external "electron" ***!
  \***************************/
/***/ ((module) => {

module.exports = require("electron");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module can't be inlined because the eval devtool is used.
/******/ 	var __webpack_exports__ = __webpack_require__("./src/preload.ts");
/******/ 	
/******/ })()
;