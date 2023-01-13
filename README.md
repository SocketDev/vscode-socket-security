# Socket Security Visual Studio Code Extension

This extension provides automatic reporting of security concerns from [Socket Security](https://socket.dev). The features of this extension aim to provide guidance through all stages of development.

## Ahead of Package Installation

* `import` and `require` in Javascript are detected and given summary scores to show concerns with configurable overlays. These overlays will persist even after package installation.

## After Package Installation

Workspaces are against Socket's reporting utilities upon detection of `package.json` files. Note these also run prior to actual installation as the presence in `package.json` is enough.

* `package.json` files and packages listed within are detected and run against more thorough issue reporting to see exact issues. These are listed in the "Problems" tab for easy access.

* `import` and `require` of packages with issues found in reporting are provided hovers which also summarize their issues.

## Pull Requests

* Simplified github application installation is provided as a code lense inside of `package.json` files by detecting the user/organization and setting up the installation workflow automatically with a simple click. These reports are more fully featured and include things such as transitive issue aggregation and diffing from one commit to another. If you want these features please install [the github app](https://github.com/marketplace/socket-security).

# Team Guide

If you are in charge of a team you may wish to setup this up as a recommended extension or other organization level settings. Please refer to our docs.
