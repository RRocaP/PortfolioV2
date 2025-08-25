// Custom Service Worker for AI Peptide Portfolio
// Provides advanced PWA features including background sync and push notifications

const CACHE_NAME = 'ai-peptide-portfolio-v1';
const OFFLINE_CACHE = 'offline-cache-v1';
const BACKGROUND_SYNC_TAG = 'form-submission-sync';

// Assets to cache for offline functionality
const STATIC_ASSETS = [
  '/ai-peptide-portfolio/',
  '/ai-peptide-portfolio/index.html',
  '/ai-peptide-portfolio/manifest.json',
  '/ai-peptide-portfolio/logo.svg'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('Service Worker installed successfully');
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME && cacheName !== OFFLINE_CACHE) {
              console.log('Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('Service Worker activated');
        return self.clients.claim();
      })
  );
});

// Fetch event - implement cache strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle navigation requests
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return caches.match('/ai-peptide-portfolio/index.html');
        })
    );
    return;
  }

  // Handle API requests with network-first strategy
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful API responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(request, responseClone);
              });
          }
          return response;
        })
        .catch(() => {
          return caches.match(request);
        })
    );
    return;
  }

  // Handle static assets with cache-first strategy
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        
        return fetch(request)
          .then((response) => {
            // Cache successful responses
            if (response.ok && request.method === 'GET') {
              const responseClone = response.clone();
              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(request, responseClone);
                });
            }
            return response;
          });
      })
      .catch(() => {
        // Return offline fallback for images
        if (request.destination === 'image') {
          return new Response('', { status: 404 });
        }
        
        // Return offline page for HTML requests
        if (request.headers.get('accept').includes('text/html')) {
          return caches.match('/ai-peptide-portfolio/index.html');
        }
      })
  );
});

// Background Sync - handle form submissions when offline
self.addEventListener('sync', (event) => {
  console.log('Background sync triggered:', event.tag);
  
  if (event.tag === BACKGROUND_SYNC_TAG) {
    event.waitUntil(
      syncFormSubmissions()
    );
  }
});

// Push notifications
self.addEventListener('push', (event) => {
  console.log('Push notification received:', event);
  
  let notificationData = {};
  
  if (event.data) {
    try {
      notificationData = event.data.json();
    } catch (e) {
      notificationData = {
        title: 'AI Peptide Portfolio',
        body: event.data.text() || 'New notification',
        icon: '/ai-peptide-portfolio/icons/icon-192x192.png',
        badge: '/ai-peptide-portfolio/icons/icon-72x72.png'
      };
    }
  }

  const options = {
    title: notificationData.title || 'AI Peptide Portfolio',
    body: notificationData.body || 'New notification',
    icon: notificationData.icon || '/ai-peptide-portfolio/icons/icon-192x192.png',
    badge: notificationData.badge || '/ai-peptide-portfolio/icons/icon-72x72.png',
    tag: notificationData.tag || 'general',
    requireInteraction: notificationData.requireInteraction || false,
    actions: notificationData.actions || [
      {
        action: 'view',
        title: 'View',
        icon: '/ai-peptide-portfolio/icons/icon-72x72.png'
      },
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ],
    data: {
      url: notificationData.url || '/ai-peptide-portfolio/',
      timestamp: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification(options.title, options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('Notification click:', event);
  
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const urlToOpen = event.notification.data?.url || '/ai-peptide-portfolio/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Check if there's already a window/tab open with the target URL
        for (let client of windowClients) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        
        // If no window/tab is open, open a new one
        if (self.clients.openWindow) {
          return self.clients.openWindow(urlToOpen);
        }
      })
  );
});

// Background sync helper function
async function syncFormSubmissions() {
  console.log('Syncing form submissions...');
  
  try {
    // Get pending form submissions from IndexedDB
    const db = await openDB();
    const transaction = db.transaction(['formSubmissions'], 'readonly');
    const store = transaction.objectStore('formSubmissions');
    const submissions = await getAllFromStore(store);

    for (const submission of submissions) {
      try {
        const response = await fetch(submission.url, {
          method: submission.method,
          headers: submission.headers,
          body: submission.body
        });

        if (response.ok) {
          // Remove successful submission from storage
          await removeFromDB(submission.id);
          console.log('Form submission synced successfully:', submission.id);
          
          // Notify the client about successful sync
          const clients = await self.clients.matchAll();
          clients.forEach(client => {
            client.postMessage({
              type: 'SYNC_SUCCESS',
              submissionId: submission.id
            });
          });
        }
      } catch (error) {
        console.error('Failed to sync submission:', submission.id, error);
      }
    }
  } catch (error) {
    console.error('Background sync failed:', error);
  }
}

// IndexedDB helpers
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('AIPortfolioDB', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('formSubmissions')) {
        const store = db.createObjectStore('formSubmissions', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
  });
}

async function getAllFromStore(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function removeFromDB(submissionId) {
  const db = await openDB();
  const transaction = db.transaction(['formSubmissions'], 'readwrite');
  const store = transaction.objectStore('formSubmissions');
  return new Promise((resolve, reject) => {
    const request = store.delete(submissionId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Performance monitoring
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Error handling
self.addEventListener('error', (event) => {
  console.error('Service Worker error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('Service Worker unhandled rejection:', event.reason);
});

console.log('Custom Service Worker loaded successfully');