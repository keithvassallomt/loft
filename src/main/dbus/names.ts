/** D-Bus object-path segment for a service (matches the GNOME helper's
 *  `displayName.replace(/\s+/g, '')` — D-Bus names can't contain spaces). */
export function dbusName(displayName: string): string {
  return displayName.replace(/\s+/g, '');
}
