vibechecker
=================

Vibe Checker CLI


[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/vibechecker.svg)](https://npmjs.org/package/vibechecker)
[![Downloads/week](https://img.shields.io/npm/dw/vibechecker.svg)](https://npmjs.org/package/vibechecker)


<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g vibechecker
$ vibechecker COMMAND
running command...
$ vibechecker (--version)
vibechecker/0.0.0 darwin-arm64 node-v24.15.0
$ vibechecker --help [COMMAND]
USAGE
  $ vibechecker COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`vibechecker hello PERSON`](#vibechecker-hello-person)
* [`vibechecker hello world`](#vibechecker-hello-world)
* [`vibechecker help [COMMAND]`](#vibechecker-help-command)
* [`vibechecker plugins`](#vibechecker-plugins)
* [`vibechecker plugins add PLUGIN`](#vibechecker-plugins-add-plugin)
* [`vibechecker plugins:inspect PLUGIN...`](#vibechecker-pluginsinspect-plugin)
* [`vibechecker plugins install PLUGIN`](#vibechecker-plugins-install-plugin)
* [`vibechecker plugins link PATH`](#vibechecker-plugins-link-path)
* [`vibechecker plugins remove [PLUGIN]`](#vibechecker-plugins-remove-plugin)
* [`vibechecker plugins reset`](#vibechecker-plugins-reset)
* [`vibechecker plugins uninstall [PLUGIN]`](#vibechecker-plugins-uninstall-plugin)
* [`vibechecker plugins unlink [PLUGIN]`](#vibechecker-plugins-unlink-plugin)
* [`vibechecker plugins update`](#vibechecker-plugins-update)

## `vibechecker hello PERSON`

Say hello

```
USAGE
  $ vibechecker hello PERSON -f <value>

ARGUMENTS
  PERSON  Person to say hello to

FLAGS
  -f, --from=<value>  (required) Who is saying hello

DESCRIPTION
  Say hello

EXAMPLES
  $ vibechecker hello friend --from oclif
  hello friend from oclif! (./src/commands/hello/index.ts)
```

_See code: [src/commands/hello/index.ts](https://github.com/Stover-Distributed-Systems-Incorporated/vibe_checker_cli/blob/v0.0.0/src/commands/hello/index.ts)_

## `vibechecker hello world`

Say hello world

```
USAGE
  $ vibechecker hello world

DESCRIPTION
  Say hello world

EXAMPLES
  $ vibechecker hello world
  hello world! (./src/commands/hello/world.ts)
```

_See code: [src/commands/hello/world.ts](https://github.com/Stover-Distributed-Systems-Incorporated/vibe_checker_cli/blob/v0.0.0/src/commands/hello/world.ts)_

## `vibechecker help [COMMAND]`

Display help for vibechecker.

```
USAGE
  $ vibechecker help [COMMAND...] [-n]

ARGUMENTS
  [COMMAND...]  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for vibechecker.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/6.2.52/src/commands/help.ts)_

## `vibechecker plugins`

List installed plugins.

```
USAGE
  $ vibechecker plugins [--json] [--core]

FLAGS
  --core  Show core plugins.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List installed plugins.

EXAMPLES
  $ vibechecker plugins
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/index.ts)_

## `vibechecker plugins add PLUGIN`

Installs a plugin into vibechecker.

```
USAGE
  $ vibechecker plugins add PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into vibechecker.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the VIBECHECKER_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the VIBECHECKER_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ vibechecker plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ vibechecker plugins add myplugin

  Install a plugin from a github url.

    $ vibechecker plugins add https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ vibechecker plugins add someuser/someplugin
```

## `vibechecker plugins:inspect PLUGIN...`

Displays installation properties of a plugin.

```
USAGE
  $ vibechecker plugins inspect PLUGIN...

ARGUMENTS
  PLUGIN...  [default: .] Plugin to inspect.

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Displays installation properties of a plugin.

EXAMPLES
  $ vibechecker plugins inspect myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/inspect.ts)_

## `vibechecker plugins install PLUGIN`

Installs a plugin into vibechecker.

```
USAGE
  $ vibechecker plugins install PLUGIN... [--json] [-f] [-h] [-s | -v]

ARGUMENTS
  PLUGIN...  Plugin to install.

FLAGS
  -f, --force    Force npm to fetch remote resources even if a local copy exists on disk.
  -h, --help     Show CLI help.
  -s, --silent   Silences npm output.
  -v, --verbose  Show verbose npm output.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Installs a plugin into vibechecker.

  Uses npm to install plugins.

  Installation of a user-installed plugin will override a core plugin.

  Use the VIBECHECKER_NPM_LOG_LEVEL environment variable to set the npm loglevel.
  Use the VIBECHECKER_NPM_REGISTRY environment variable to set the npm registry.

ALIASES
  $ vibechecker plugins add

EXAMPLES
  Install a plugin from npm registry.

    $ vibechecker plugins install myplugin

  Install a plugin from a github url.

    $ vibechecker plugins install https://github.com/someuser/someplugin

  Install a plugin from a github slug.

    $ vibechecker plugins install someuser/someplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/install.ts)_

## `vibechecker plugins link PATH`

Links a plugin into the CLI for development.

```
USAGE
  $ vibechecker plugins link PATH [-h] [--install] [-v]

ARGUMENTS
  PATH  [default: .] path to plugin

FLAGS
  -h, --help          Show CLI help.
  -v, --verbose
      --[no-]install  Install dependencies after linking the plugin.

DESCRIPTION
  Links a plugin into the CLI for development.

  Installation of a linked plugin will override a user-installed or core plugin.

  e.g. If you have a user-installed or core plugin that has a 'hello' command, installing a linked plugin with a 'hello'
  command will override the user-installed or core plugin implementation. This is useful for development work.


EXAMPLES
  $ vibechecker plugins link myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/link.ts)_

## `vibechecker plugins remove [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ vibechecker plugins remove [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ vibechecker plugins unlink
  $ vibechecker plugins remove

EXAMPLES
  $ vibechecker plugins remove myplugin
```

## `vibechecker plugins reset`

Remove all user-installed and linked plugins.

```
USAGE
  $ vibechecker plugins reset [--hard] [--reinstall]

FLAGS
  --hard       Delete node_modules and package manager related files in addition to uninstalling plugins.
  --reinstall  Reinstall all plugins after uninstalling.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/reset.ts)_

## `vibechecker plugins uninstall [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ vibechecker plugins uninstall [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ vibechecker plugins unlink
  $ vibechecker plugins remove

EXAMPLES
  $ vibechecker plugins uninstall myplugin
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/uninstall.ts)_

## `vibechecker plugins unlink [PLUGIN]`

Removes a plugin from the CLI.

```
USAGE
  $ vibechecker plugins unlink [PLUGIN...] [-h] [-v]

ARGUMENTS
  [PLUGIN...]  plugin to uninstall

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Removes a plugin from the CLI.

ALIASES
  $ vibechecker plugins unlink
  $ vibechecker plugins remove

EXAMPLES
  $ vibechecker plugins unlink myplugin
```

## `vibechecker plugins update`

Update installed plugins.

```
USAGE
  $ vibechecker plugins update [-h] [-v]

FLAGS
  -h, --help     Show CLI help.
  -v, --verbose

DESCRIPTION
  Update installed plugins.
```

_See code: [@oclif/plugin-plugins](https://github.com/oclif/plugin-plugins/blob/5.4.78/src/commands/plugins/update.ts)_
<!-- commandsstop -->
