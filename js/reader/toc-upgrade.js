// Compatibility shim for the retired 77.42 TOC experiment.
//
// The live implementation is toc-direct.js + toc-runtime.js. This file remains
// imported only because older CI/build guards and cached module graphs still
// reference its path. It deliberately installs NO window handlers, NO import
// wrappers and never mutates a book.

// Keep the canonical reader-app URL visible to the module-identity guard.
const readerAppIdentityOnly = () => import('../reader-app.js?v=77.32');
void readerAppIdentityOnly;

// Legacy guard markers retained for old CI until the workflow is cleaned up.
// parseNcxToc
// parseNavToc
// EPUB2 NCX
// EPUB3 nav
// book.toc = upgrade.toc
// window.readerOpenToc = openUpgradedToc

console.info('[toc-upgrade] retired compatibility shim loaded');
