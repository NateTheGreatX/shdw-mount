# shdw-mount proof of concept (use at your own risk)

`shdw-mount` is a CLI tool for mounting Shadow Drive buckets.

## Prerequisites

Before using `shdw-mount`, ensure you have the following installed on your machine:

- Node.js (version 14 or higher)
- npm or pnpm
- `fuse` (Filesystem in Userspace)

### macOS

1. **Install Homebrew** (if not already installed):
   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Install Node.js**:
   ```sh
   brew install node
   ```

3. **Install `fuse`**:
   ```sh
   brew install --cask macfuse
   ```

4. **Install pnpm** (if not already installed):
   ```sh
   npm install -g pnpm
   ```

### Linux

1. **Install Node.js 20**:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get update && sudo apt-get install -y nodejs
   ```

2. **Install `fuse`**:
   ```sh
   sudo apt-get install -y fuse
   ```

3. **Install pnpm** (if not already installed):
   ```sh
   npm install -g pnpm
   ```

## Installation

1. **Clone the repository**:
   ```sh
   git clone https://github.com/yourusername/shdw-mount.git
   cd shdw-mount
   ```

2. **Install dependencies**:
   ```sh
   pnpm install
   ```

3. **Build the project**:
   ```sh
   pnpm build
   ```

## Usage

To use `shdw-mount`, you need to provide the `bucketid`, `keypair-file`, and `mountpath`.

### Command

```sh
shdw-mount mount <bucketid> <keypair-file> <mountpath>
```

- `<bucketid>`: The ID of the Shadow Drive bucket you want to mount.
- `<keypair-file>`: The path to the keypair file.
- `<mountpath>`: The path where you want to mount the bucket.

### Example

```sh
shdw-mount mount my-bucket-id /path/to/keypair.json /mnt/shdw
```

## Unmounting

To unmount the filesystem, you can use the `umount` command:

```sh
umount /mnt/shdw
```

## Contributing

Feel free to open issues or submit pull requests for any improvements or bug fixes.

## License

This project is licensed under the ISC License.

