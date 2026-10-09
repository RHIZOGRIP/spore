{
  "targets": [
    {
      "target_name": "sandbox",
      "sources": ["src/isolation/sandbox.c"],
      "cflags": ["-std=c11", "-Wall", "-Wextra"]
    },
    {
      "target_name": "confine",
      "type": "executable",
      "sources": ["src/isolation/confine.c"],
      "cflags": ["-std=c11", "-Wall", "-Wextra"]
    }
  ]
}
