package main

import (
    "encoding/json"
    "bufio"
    "os"
    "go/parser"
    "go/token"
    "strconv"
)

// Eventually maybe migrate to WASI with tinygo


type VSPosition struct {
    Line int `json:"line"`
    Character int `json:"character"`
}

type VSRange struct {
    Start VSPosition `json:"start"`
    End VSPosition `json:"end"`
}

type GoImport struct {
    Name string `json:"name"`
    Range VSRange `json:"range"`
}

func toVSPos(src token.Position) VSPosition {
    // TODO: breaks on unicode but probably rare enough to not matter
    return VSPosition { src.Line - 1, src.Column - 1, }
}

func main() {
    reader := bufio.NewReader(os.Stdin)
    fset := token.NewFileSet()
    file, err := parser.ParseFile(fset, "src.go", reader, parser.ImportsOnly)

    if err != nil {
        os.Stderr.Write([]byte(err.Error()))
        os.Exit(1)
    }

    results := make([]GoImport, 0)
    
    for _, imp := range file.Imports {
        start := fset.Position(imp.Pos())
        end := fset.Position(imp.End())
        name, nameErr := strconv.Unquote(imp.Path.Value)

        if nameErr != nil {
            os.Stderr.Write([]byte(nameErr.Error()))
            os.Exit(1)
        }

        results = append(results, GoImport {
            name,
            VSRange { toVSPos(start), toVSPos(end), },
        })
    }

    result, encErr := json.Marshal(results)
    if encErr != nil {
        os.Stderr.Write([]byte(err.Error()))
        os.Exit(1)
    }

    os.Stdout.Write(result)
}