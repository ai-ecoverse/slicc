// Re-export the shared tray VFS / File Provider module so every
// `import SliccTrayKit` consumer (the app, the File Provider appex, tests)
// keeps seeing those types unqualified.
@_exported import SliccTrayVFS
