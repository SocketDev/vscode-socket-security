# Socket Security Visual Studio Code Extension

This extension provides automatic reporting of security concerns from [Socket Security](https://socket.dev). The features of this extension aim to provide guidance through all stages of development.

## Ahead of Package Installation

* Package imports in JavaScript and Python are detected and given summary scores to show concerns with configurable overlays. These overlays will persist even after package installation.

* Socket detects multiple alternate forms of package imports, including dynamic `import()` or `require` in JavaScript or `importlib.import_module` in Python.

## MCP Server

* This will automatically register the socket MCP server at https://mcp.socket.dev to allow usage of the public MCP server.

# Team Guide

If you are in charge of a team you may wish to setup this up as a recommended extension or other organization level settings. Please refer to our docs.
