# CLI.ts

It is the entry point of the application, It contains `runHumanToCodeCli` which is the main function that is ran when user types `npx human-to-code .`.

## Function: runHumanToCodeCli(argv: string[])

This function is the entry point of the CLI,It is the main driver of the application. It parses the arguments ( like --init, --provider, --help) and runs the entire workflow of `npx human-to-code .` or `npx human-to-code ./src`.

## isMainModule()

This function checks if the file is being run as the main program or not. It is used to prevent the application from running when it is imported as a library.
