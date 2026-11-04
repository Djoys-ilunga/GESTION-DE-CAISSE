/* Vérifie une fenêtre X11 visible et capture son rendu réel sous Linux. */
#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xlib.h>
#include <string.h>

static char *window_title(Display *display, Window window) {
  Atom actual_type;
  int format;
  unsigned long length, remaining;
  unsigned char *value = NULL;
  Atom property = XInternAtom(display, "_NET_WM_NAME", False);
  if (XGetWindowProperty(display, window, property, 0, 1024, False,
                         AnyPropertyType, &actual_type, &format, &length,
                         &remaining, &value) == Success && value) {
    char *title = format == 8 ? g_strndup((const char *)value, length) : NULL;
    XFree(value);
    if (title) return title;
  }
  char *legacy = NULL;
  if (!XFetchName(display, window, &legacy) || !legacy) return NULL;
  char *title = g_strdup(legacy);
  XFree(legacy);
  return title;
}

static Window find_window(Display *display, Window parent) {
  Window root, parent_return, *children = NULL;
  unsigned int count = 0;
  if (!XQueryTree(display, parent, &root, &parent_return, &children, &count)) return None;
  Window found = None;
  for (unsigned int index = 0; index < count && found == None; index++) {
    char *title = NULL;
    XWindowAttributes attributes;
    if (g_getenv("CAISSEPRO_NATIVE_DIAGNOSTICS") &&
        XGetWindowAttributes(display, children[index], &attributes)) {
      char *diagnostic_title = window_title(display, children[index]);
      g_printerr("Native window: title=%s size=%dx%d state=%d\n",
                 diagnostic_title ? diagnostic_title : "(none)",
                 attributes.width, attributes.height, attributes.map_state);
      g_free(diagnostic_title);
    }
    title = window_title(display, children[index]);
    if (title &&
        strncmp(title, "CaissePro", strlen("CaissePro")) == 0 &&
        XGetWindowAttributes(display, children[index], &attributes) &&
        attributes.map_state == IsViewable && attributes.width >= 650 && attributes.height >= 650)
      found = children[index];
    g_free(title);
    if (found == None) found = find_window(display, children[index]);
  }
  if (children) XFree(children);
  return found;
}

int main(int argc, char **argv) {
  if (argc != 2 || !gtk_init_check(NULL, NULL)) return 2;
  GdkDisplay *gdk_display = gdk_display_get_default();
  Display *display = gdk_x11_display_get_xdisplay(gdk_display);
  Window native = None;
  for (int attempt = 0; attempt < 80 && native == None; attempt++) {
    native = find_window(display, DefaultRootWindow(display));
    if (native == None) g_usleep(250000);
  }
  if (native == None) { g_printerr("CAISSEPRO_NATIVE_WINDOW_NOT_FOUND\n"); return 3; }
  GdkWindow *window = gdk_x11_window_foreign_new_for_display(gdk_display, native);
  if (!window) return 4;
  int width = gdk_window_get_width(window), height = gdk_window_get_height(window);
  GdkPixbuf *pixels = NULL;
  gboolean rendered = FALSE;
  for (int attempt = 0; attempt < 80 && !rendered; attempt++) {
    while (g_main_context_iteration(NULL, FALSE)) {}
    if (pixels) g_object_unref(pixels);
    pixels = gdk_pixbuf_get_from_window(window, 0, 0, width, height);
    if (pixels) {
      const guchar *data = gdk_pixbuf_get_pixels(pixels);
      int channels = gdk_pixbuf_get_n_channels(pixels);
      int stride = gdk_pixbuf_get_rowstride(pixels);
      int different = 0, samples = 0;
      for (int y = 0; y < height; y += 8) for (int x = 0; x < width; x += 8) {
        const guchar *pixel = data + y * stride + x * channels;
        if (ABS((int)pixel[0] - data[0]) + ABS((int)pixel[1] - data[1]) + ABS((int)pixel[2] - data[2]) > 30) different++;
        samples++;
      }
      rendered = different > samples / 20;
    }
    if (!rendered) g_usleep(250000);
  }
  if (!pixels) { g_object_unref(window); return 5; }
  GError *error = NULL;
  gboolean saved = gdk_pixbuf_save(pixels, argv[1], "png", &error, NULL);
  g_object_unref(pixels);
  g_object_unref(window);
  if (!saved) { if (error) g_error_free(error); return 6; }
  if (!rendered) { g_printerr("CAISSEPRO_NATIVE_RENDER_EMPTY\n"); return 7; }
  g_print("CAISSEPRO_NATIVE_WINDOW_VISIBLE %dx%d\n", width, height);
  return 0;
}
