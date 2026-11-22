/** Camp photos live on the Cloudflare Workers CDN; each <img> falls back to /assets/gallery/gXX.jpg. */
const rawGalleryBase: string =
  import.meta.env.PUBLIC_GALLERY_BASE_URL || 'https://comcamp25-gallery.sokulshop5.workers.dev/';

export const GALLERY_BASE_URL = rawGalleryBase.endsWith('/') ? rawGalleryBase : `${rawGalleryBase}/`;
