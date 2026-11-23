import 'vue-router'

// Extend route meta for the login guard
declare module 'vue-router' {
  interface RouteMeta {
    // Only signed-in users can access; redirect to /login otherwise
    requiresAuth?: boolean
    // Only guests can access; redirect to /home when signed in
    guestOnly?: boolean
  }
}
