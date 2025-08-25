// Service Worker for Portfolio Site
// Version-based caching with stale-while-revalidate for pages and cache-first for static assets

const CACHE_VERSION = 'v1.0.0';
const STATIC_CACHE = `portfolio-static-${CACHE_VERSION}`;
const PAGES_CACHE = `portfolio-pages-${CACHE_VERSION}`;
const OFFLINE_PAGE = '/Portfolio/offline.html';

// Feature flags - background sync disabled by default for GitHub Pages
const FEATURES = {
  BACKGROUND_SYNC: false, // Enable only when serverless endpoints available
  UPDATE_NOTIFICATIONS: true,
  OFFLINE_FALLBACK: true
};

// Assets to cache on install
const STATIC_ASSETS = [
  '/Portfolio/',
  '/Portfolio/manifest.json',
  '/Portfolio/profile.avif',
  '/Portfolio/profile.webp',
  '/Portfolio/profile.jpg',
  // Add critical CSS and JS files
  // Note: Actual asset URLs will be determined at runtime
];

// Pages to pre-cache
const PAGES_TO_CACHE = [
  '/Portfolio/en/',
  '/Portfolio/es/',
  '/Portfolio/ca/',
  '/Portfolio/offline.html'
];

// Assets that should use cache-first strategy
const CACHE_FIRST_PATTERNS = [
  /\.(?:png|jpg|jpeg|webp|avif|gif|svg|ico)$/,
  /\.(?:css|js)$/,
  /\.(?:woff|woff2|ttf|eot)$/,
  /\/manifest\.json$/
];

// URLs to exclude from caching
const EXCLUDE_PATTERNS = [
  /\/api\//,           // Never cache API routes
  /\/admin\//,         // Admin interfaces
  /\.(?:map)$/,        // Source maps
  /\/sw\.js$/,         // Service worker itself
  /chrome-extension:/, // Browser extensions
  /moz-extension:/     // Firefox extensions
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Installing service worker version:', CACHE_VERSION);
  
  event.waitUntil(
    Promise.all([
      // Cache static assets
      caches.open(STATIC_CACHE).then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[SW] Failed to cache some static assets:', err);
          // Don't fail installation if some assets fail to cache
        });
      }),
      
      // Cache key pages
      caches.open(PAGES_CACHE).then(cache => {
        console.log('[SW] Caching key pages');
        return cache.addAll(PAGES_TO_CACHE).catch(err => {
          console.warn('[SW] Failed to cache some pages:', err);
        });
      })
    ])
  );
  
  // Skip waiting to activate immediately
  if (FEATURES.UPDATE_NOTIFICATIONS) {
    // Let the main thread handle update notifications
    self.skipWaiting();
  }
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker version:', CACHE_VERSION);
  
  event.waitUntil(
    Promise.all([
      // Clean up old caches
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName.includes('portfolio-') && 
                !cacheName.includes(CACHE_VERSION)) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      
      // Claim all clients immediately
      self.clients.claim()
    ])
  );
  
  // Notify clients about the update
  if (FEATURES.UPDATE_NOTIFICATIONS) {
    notifyClientsOfUpdate();
  }
});

// Fetch event - handle all network requests
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests and excluded patterns
  if (request.method !== 'GET' || shouldExclude(url)) {
    return;
  }
  
  // Handle different types of requests
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstStrategy(request));
  } else if (isPageRequest(request)) {
    event.respondWith(staleWhileRevalidateStrategy(request));
  }
});

// Background sync for contact form (when enabled)
if (FEATURES.BACKGROUND_SYNC) {
  self.addEventListener('sync', event => {
    if (event.tag === 'contact-form') {
      console.log('[SW] Background sync: contact-form');
      event.waitUntil(syncContactForm());
    }
  });
}

// Message handling for client communication
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};
  
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    
    case 'GET_VERSION':
      event.ports[0].postMessage({ version: CACHE_VERSION });
      break;
    
    case 'CLEAR_CACHES':
      clearAllCaches().then(() => {
        event.ports[0].postMessage({ success: true });
      }).catch(err => {
        event.ports[0].postMessage({ success: false, error: err.message });
      });
      break;
    
    case 'QUEUE_CONTACT_FORM':
      if (FEATURES.BACKGROUND_SYNC && payload) {
        queueContactForm(payload);
      }
      break;
  }
});

// Cache-first strategy for static assets
async function cacheFirstStrategy(request) {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Update cache in background
      fetch(request).then(response => {
        if (response.status === 200) {
          cache.put(request, response.clone());
        }
      }).catch(() => {
        // Ignore network errors in background update
      });
      
      return cachedResponse;
    }
    
    // Not in cache, fetch from network
    const networkResponse = await fetch(request);
    
    if (networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.warn('[SW] Cache-first strategy failed:', error);
    return new Response('Asset unavailable', { status: 503 });
  }
}

// Stale-while-revalidate strategy for pages
async function staleWhileRevalidateStrategy(request) {
  try {
    const cache = await caches.open(PAGES_CACHE);
    const cachedResponse = await cache.match(request);
    
    // Always try to fetch from network
    const networkPromise = fetch(request).then(response => {
      if (response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => null);
    
    // Return cached version immediately if available
    if (cachedResponse) {
      networkPromise.catch(() => {}); // Prevent unhandled promise rejection
      return cachedResponse;
    }
    
    // Wait for network if no cached version
    const networkResponse = await networkPromise;
    
    if (networkResponse) {
      return networkResponse;
    }
    
    // Fallback to offline page
    if (FEATURES.OFFLINE_FALLBACK) {
      return await cache.match(OFFLINE_PAGE) || 
             new Response('Offline', { status: 503 });
    }
    
    return new Response('Page unavailable', { status: 503 });
  } catch (error) {
    console.warn('[SW] Stale-while-revalidate strategy failed:', error);
    
    // Try offline fallback
    if (FEATURES.OFFLINE_FALLBACK) {
      try {
        const cache = await caches.open(PAGES_CACHE);
        return await cache.match(OFFLINE_PAGE) || 
               new Response('Offline', { status: 503 });
      } catch (fallbackError) {
        return new Response('Service unavailable', { status: 503 });
      }
    }
    
    return new Response('Service unavailable', { status: 503 });
  }
}

// Helper functions
function shouldExclude(url) {
  // Check for ?nocache query parameter
  if (url.searchParams.has('nocache')) {
    return true;
  }
  
  return EXCLUDE_PATTERNS.some(pattern => pattern.test(url.href));
}

function isStaticAsset(url) {
  return CACHE_FIRST_PATTERNS.some(pattern => pattern.test(url.pathname));
}

function isPageRequest(request) {
  return request.headers.get('accept')?.includes('text/html');
}

function notifyClientsOfUpdate() {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'SW_UPDATED',
        version: CACHE_VERSION
      });
    });
  });
}

async function clearAllCaches() {
  const cacheNames = await caches.keys();
  return Promise.all(
    cacheNames.map(cacheName => caches.delete(cacheName))
  );
}

// Background sync functions (when enabled)
async function queueContactForm(data) {
  if (!FEATURES.BACKGROUND_SYNC) return;
  
  try {
    // Store form data in IndexedDB for background sync
    const db = await openDB();
    const transaction = db.transaction(['contact_queue'], 'readwrite');
    const store = transaction.objectStore('contact_queue');
    
    await store.add({
      ...data,
      timestamp: Date.now(),
      attempts: 0
    });
    
    console.log('[SW] Contact form queued for background sync');
  } catch (error) {
    console.error('[SW] Failed to queue contact form:', error);
  }
}

async function syncContactForm() {
  if (!FEATURES.BACKGROUND_SYNC) return;
  
  try {
    const db = await openDB();
    const transaction = db.transaction(['contact_queue'], 'readwrite');
    const store = transaction.objectStore('contact_queue');
    const items = await store.getAll();
    
    for (const item of items) {
      try {
        const response = await fetch('/Portfolio/api/contact', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(item)
        });
        
        if (response.ok) {
          await store.delete(item.id);
          console.log('[SW] Contact form synced successfully');
        } else if (item.attempts < 3) {
          // Retry up to 3 times
          await store.put({ ...item, attempts: item.attempts + 1 });
        } else {
          // Remove after 3 failed attempts
          await store.delete(item.id);
          console.warn('[SW] Contact form sync failed after 3 attempts');
        }
      } catch (error) {
        console.error('[SW] Contact form sync error:', error);
        
        if (item.attempts < 3) {
          await store.put({ ...item, attempts: item.attempts + 1 });
        } else {
          await store.delete(item.id);
        }
      }
    }
  } catch (error) {
    console.error('[SW] Background sync failed:', error);
  }
}

// IndexedDB helper (for background sync)
function openDB() {
  return new Promise((resolve, reject) => {
    if (!FEATURES.BACKGROUND_SYNC) {
      reject(new Error('Background sync not enabled'));
      return;
    }
    
    const request = indexedDB.open('portfolio-sw', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = event => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('contact_queue')) {
        const store = db.createObjectStore('contact_queue', { 
          keyPath: 'id', 
          autoIncrement: true 
        });
        store.createIndex('timestamp', 'timestamp');
      }
    };
  });
}

// Log service worker registration
console.log(`[SW] Service worker loaded - Version: ${CACHE_VERSION}`);
console.log(`[SW] Features enabled:`, FEATURES);