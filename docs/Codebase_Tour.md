# CLI.ts

It is the entry point of the application, It contains `runHumanToCodeCli` which is the main function that is ran when user types `npx human-to-code .`.

## Function: runHumanToCodeCli(argv: string[])

This function is the entry point of the CLI,It is the main driver of the application. It parses the arguments ( like --init, --provider, --help) and runs the entire workflow of `npx human-to-code .` or `npx human-to-code ./src`.

## Function: isMainModule()

This function checks if the file is being run as the main program or not. It is used to prevent the application from running when it is imported as a library.

## Function: buildCommand(cli: CliOptions, rootInput?: string)

This function does the actual heavy lifting of the CLI. First it loads the configuration and finds all the `.human` files that need to be converted. Then it shows a plan to the user and asks for confirmation (unless `--yes` is passed). After getting confirmation, it uses the AI provider (like OpenAI or Ollama) to generate the actual code. It also does cross-file checks to make sure everything connects properly, fixes any errors, and finally saves the generated files to the disk. You can say this is the main core logic function of our app.

### Parameters

* **`cli` (`CliOptions`)**: This parameter contains all the settings and flags that the user types in the terminal. For example, if they use `--yes` to skip confirmation, `--provider` to pick OpenAI or Ollama, or `--dry-run` to just test things out without making real changes. It basically holds the entire configuration passed from the command line.
* **`rootInput` (`string`, Optional)**: This is the path of the folder where the user wants to run the tool. For example, if someone types `npx human-to-code ./src`, then `./src` will be the `rootInput`. If they don't provide any folder path, it automatically uses the current folder (`.`). The `?` means this parameter is optional.
