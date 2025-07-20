export function generatePythonBuiltinsExtractor() {
    return `
        import sys
        import pkgutil
        import os
        import json

        # Built-in modules
        builtin_modules = set(sys.builtin_module_names)

        # Standard library modules
        stdlib_path = os.path.dirname(os.__file__)
        stdlib_modules = set(module.name for module in pkgutil.iter_modules([stdlib_path]))

        # Combine and sort
        all_modules = sorted(builtin_modules | stdlib_modules)

        # Print as JSON
        print(json.dumps(all_modules, indent=2))
    `
}
