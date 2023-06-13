# Socket Security Visual Studio Code Extension

This extension provides automatic reporting of security concerns from [Socket Security](https://socket.dev). The features of this extension aim to provide guidance through all stages of development.

## Ahead of Package Installation

* Package imports in JavaScript and Python are detected and given summary scores to show concerns with configurable overlays. These overlays will persist even after package installation.

* Socket detects multiple alternate forms of package imports, including dynamic `import()` or `require` in JavaScript or `importlib.import_module` in Python.

## After Package Installation

Workspaces are run against Socket's reporting utilities upon detection of JavaScript or Python dependencies. Note these also run prior to actual installation: presence in `package.json`, `requirements.txt`, or any other supported file is enough.

* Package dependency files like `package.json` and `pyproject.toml` are run against more thorough issue reporting to see exact issues for each dependency. These are listed in the "Problems" tab for easy access.

* You can hover over package imports in JavaScript or Python code to see a summary of their issues.

## Pull Requests

* Simplified GitHub application installation is available as a code lens. It detects your username/organization and sets up the installation workflow automatically with a simple click. These reports are more extensive than the ones provided within the extension and include things such as transitive issue aggregation and diffing from one commit to another. If you want these features, please install [the GitHub app](https://github.com/marketplace/socket-security).

# Team Guide

If you are in charge of a team you may wish to setup this up as a recommended extension or other organization level settings. Please refer to our docs.
