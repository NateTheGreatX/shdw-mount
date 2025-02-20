#!/usr/bin/env node
import { Command } from 'commander';
import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { ShdwDriveSDK } from '@shdwdrive/sdk';
import * as fuse from '@cocalc/fuse-native';
import * as pathTools from 'path';
import axios from 'axios';
import { NodeFile } from './utils/NodeFile';
import { calculateTransferRate, sleep } from "./utils";
import { UploadUtils } from "./utils/uploadUtils";
import { getOps } from "./utils/ops";

const program = new Command();

program
    .name('shdw-mount')
    .description('CLI tool for mounting Shadow Drive buckets')
    .version(require('../package.json').version);

program
    .command('mount <bucketid> <keypair-file> <mountpath>')
    .description('Mount a Shadow Drive bucket')
    .action(async (bucketId: string, keypairFile: string, mountpath: string) => {
      try {
        // Load keypair
        const keypairData = JSON.parse(readFileSync(keypairFile, 'utf-8'));
        const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));

        // Initialize SDK
        const sdk = new ShdwDriveSDK(
            {endpoint: process.env.SHDW_ENDPOINT || 'https://v2.shdwdrive.com'},
            {keypair}
        );

        // Fetch files from the bucket
        const fileCache = {
          files: [] as { key: string, size: number, lastModified: string, folder: string }[],
          lastUpdated: 0
        };

        const getFiles = async (): Promise<{
          key: string,
          size: number,
          lastModified: string,
          folder: string
        }[]> => {
          const cacheDuration = 60000; // Cache duration in milliseconds (e.g., 1 minute)
          const now = Date.now();

          if (now - fileCache.lastUpdated < cacheDuration) {
            return fileCache.files;
          }

          const files: any = await sdk.listFiles(bucketId);
          // if the last character is a / then it is a folder and remove it
          fileCache.files = files.map(i => {
            // convert key to a path compatible with the fuse filesystem
            return ({
              ...i,
              path: `/${i.key.slice(-1) === '/' ? i.key.slice(0, -1) : i.key}`,
              buffering: false
            });
          });
          fileCache.lastUpdated = now;

          return fileCache.files;
        };

        const invalidateCache = () => {
          fileCache.lastUpdated = 0;
        };
        let fileHandleCounter = 0;
        const openFiles = new Map<number, string>();
        const readingFile = new Map<string, Buffer>();
        const fileBuffer = {};
        const readBuffer: {
          [key: string]: {
            buffer: Buffer;
            finished: boolean;
            skipped: number;
            bytesRead: number;
            firstRun: boolean;
            started: number;
          }
        } = {};
        // setup semaphore for limiting the number of concurrent uploads to 5

        const {uploadChunkTask, completeLargeFile, createLargeFile} = new UploadUtils({keypair, bucketId});

        const opsObj = getOps({bucketId, fileBuffer, sdk, invalidateCache, uploadChunkTask, completeLargeFile});

        const ops = {
          statfs: async (path, cb) => {
            const result = await sdk.getBucketUsage(bucketId)
            const stats = {
              bsize: 1024,      // Block size
              frsize: 1024,     // Fragment size
              blocks: 5000000,  // Total number of blocks
              bfree: 5000000 - result.storage_used / 1024,   // Number of free blocks
              bavail: 50000,    // Number of free blocks for unprivileged users
              // files: 1000,   // Total number of file nodes
              // ffree: 500,    // Number of free file nodes
              // favail: 500,   // Number of free file nodes for unprivileged users
              fsid: 77777,      // Filesystem ID
              flag: 0,          // Mount flags
              namemax: 255      // Maximum length of filenames
            };
            cb(null, stats);
          },
          create: async (path: string, mode: number, cb: (code: number, fd: number) => void) => {
            console.log('create(%s, %d)', path, mode);
            try {
              const fileName = pathTools.basename(path);
              const relativePath = pathTools.dirname(path).slice(1);
              console.log('Creating file:', fileName, 'in directory:', relativePath);
              await sdk.uploadFile(bucketId, new NodeFile(Buffer.from([1]), fileName), {directory: relativePath});
              invalidateCache();
              const fd = fileHandleCounter++;
              openFiles.set(fd, path);
              console.log('File created with handle:', fd);
              return cb(0, fd);
            } catch (error) {
              console.error('Error creating file:', error);
              cb(fuse.default.ENOENT, -1);
            }
          },
          mkdir: async (path: string, mode: number, cb: (code: number) => void) => {
            console.log('mkdir(%s, %d)', path, mode);
            try {
              // const directoryName = pathTools.basename(path);
              const relativePath = pathTools.dirname(path + '/').slice(1);
              // const fullPath = relativePath ? `${relativePath}/${directoryName}` : directoryName;

              // Perform the directory creation operation
              await sdk.createFolder(bucketId, path.slice(1));
              invalidateCache();
              console.log('Directory created:', relativePath);
              cb(0);
            } catch (error) {
              console.error('Error creating directory:', error);
              cb(fuse.default.ENOENT);
            }
          },
          // called when deleting
          unlink: async (path: string, cb: (code: number) => void) => {
            console.log('delete(%s)', path);
            try {
              // remove initial slash from path
              const file = path.slice(1);
              if (fileBuffer[path]) {
                delete fileBuffer[path]; // remove the file from the buffer if it's still there
              }
              await sdk.deleteFile(bucketId, file);
              invalidateCache();
              cb(0);
            } catch (error) {
              console.error('Error deleting file:', error);
              cb(fuse.default.ENOENT);
            }
          },
          truncate: async (path: string, size: number, cb: (code: number) => void) => {
            console.log('truncate(%s, %d)', path, size);
            try {
              const fileName = pathTools.basename(path);
              const relativePath = pathTools.dirname(path).slice(1);
              const file = new NodeFile(Buffer.alloc(size + 1), fileName);
              await sdk.uploadFile(bucketId, file, {directory: relativePath});
              invalidateCache();
              cb(0);
            } catch (error) {
              console.error('Error truncating file:', error);
              cb(fuse.default.ENOENT);
            }
          },
          write: async (path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (code: number, bytesWritten?: number) => void) => {
            // console.log('write(%s, %d, %d, %d)', path, fd, len, pos);
            try {
              if (!fileBuffer[path]) {
                fileBuffer[path] = {
                  buffer: Buffer.alloc(0),
                  chunkNumber: 0,
                  uploadedParts: [],
                  uploadedPartsTasks: [],
                  timeStarted: Date.now(),
                };
              }
              // Instead of pushing to an array, concatenate immediately
              fileBuffer[path].buffer = Buffer.concat([fileBuffer[path].buffer, buf.slice(0, len)]);
              // if the length is bigger than 5MB we need to upload the file in 5MB chunks
              const size = fileBuffer[path].buffer.length;
              // console.log('Size:', size);
              if (size > 5 * 1024 * 1024) {
                // console.log('Uploading file in chunks');
                const chunk = fileBuffer[path].buffer.slice(0, 5 * 1024 * 1024);
                fileBuffer[path].buffer = fileBuffer[path].buffer.slice(5 * 1024 * 1024);
                // save which chunk number we are on
                fileBuffer[path].chunkNumber++;
                fileBuffer[path].isLarge = true;
                if (fileBuffer[path].chunkNumber === 1) {
                  console.log('Creating large file');
                  // create the file on the server on only the first chunk
                  const fileType = pathTools.basename(path).split('.').pop();
                  const {uploadId, key} = await createLargeFile({
                    directory: pathTools.dirname(path).slice(1),
                    file: {
                      name: pathTools.basename(path),
                      size: size,
                      type: fileType
                    }
                  });
                  fileBuffer[path].uploadId = uploadId;
                  fileBuffer[path].key = key;
                }
                fileBuffer[path].uploadedPartsTasks.push(uploadChunkTask({
                  uploadId: fileBuffer[path].uploadId,
                  key: fileBuffer[path].key,
                  path,
                  chunk,
                  partNumber: fileBuffer[path].chunkNumber,
                  fileName: pathTools.basename(path)
                }));

              }

              process.nextTick(cb, len);
            } catch (error) {
              console.error('Error writing file:', error);
              process.nextTick(cb, fuse.default.ENOENT);
            }
          },
          flush: opsObj.flush,
          rmdir: async (path: string, cb: (code: number) => void) => {
            console.log('rmdir(%s)', path);
            try {
              await sdk.deleteFolder(bucketId, path.slice(1));
              invalidateCache();
              cb(0);
            } catch (error) {
              console.error('Error deleting folder:', error);
              cb(fuse.default.ENOENT);
            }
          },
          // xattr stuff get and set
          getxattr: async (path: string, name: string, size: number, cb: (err: number) => void) => cb(0),
          removexattr: async (path: string, name: string, cb: (err: number) => void) => cb(0),
          listxattr: async (path: string, cb: (err: number, list?: string[]) => void) => cb(0, []),
          setxattr: async (path: string, name: string, value: Buffer, size: number, flags: number, cb: (err: number) => void) => cb(0),
          readdir: async (path: string, cb: (code: number, entries: string[]) => void) => {
            // console.log('readdir(%s)', path);
            const files: any = await getFiles();
            const entries = files.filter(item => {
              const fileName = pathTools.basename(item.path);
              const relativePath = pathTools.dirname(item.path);
              return path == relativePath;
            }).map(item => pathTools.basename(item.key));
            return cb(0, entries);
          },
          getattr: async (path: string, cb: (code: number, stat?: any) => void) => {
            // Root directory.  use getBucketUsage for size
            // console.log('getattr(%s)', path);
            if (path === '/') {
              sdk.getBucketUsage(bucketId).then(bucket => {
                return cb(0, {
                  mtime: new Date(),
                  atime: new Date(),
                  ctime: new Date(),
                  size: bucket.storage_used,
                  mode: 0o40755, // Directory with rwxr-xr-x permissions
                  uid: process.getuid ? process.getuid() : 0,
                  gid: process.getgid ? process.getgid() : 0,
                });
              }).catch(err => {
                console.error('Error getting bucket usage:', err);
                return cb(fuse.default.ENOENT);
              });
            } else {
              const files = await getFiles();
              const item: any = files.find((item: any) => item.path == path);
              // console.log(files);
              if (item) {
                // Construct the stat object based on the item's properties
                return cb(0, {
                  mtime: new Date(item.lastModified),
                  atime: new Date(item.lastModified), // Assuming atime equals mtime if not provided
                  ctime: new Date(item.lastModified), // Similarly for ctime
                  size: item.size,
                  // if it's a folder make permissions directory permissions
                  mode: item.type === 'folder' ? 0o40755 : 0o100644, // Directory or file permissions. 0o100666 is a regular file with rw-rw-rw- permissions (octal)
                  uid: process.getuid ? process.getuid() : 0,
                  gid: process.getgid ? process.getgid() : 0,
                });
              } else {
                return cb(fuse.default.ENOENT); // File not found
              }
            }
          },
          open: (path: string, flags: number, cb: (code: number, fd: number) => void) => {
            //console.log('open(%s, %d)', path, flags);
            const fd = fileHandleCounter++;
            openFiles.set(fd, path);
            cb(0, fd);
          },
          // example of using range for getting the file in chunks as requested by the OS. extremely slow since it has
          // to establish a new connection for every byte range (usually 65535 bytes)
          readRange: async (path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead?: number) => void) => {
            // try using the range feature using axios and the range header
            const fileName = pathTools.basename(path);
            const relativePath = pathTools.dirname(path).slice(1);
            const url = `https://v2.shdwdrive.com/${bucketId}${path}`;
            // console.log(`read(%s, %d, %d, %d), bytes=${pos}-${pos + len}`, path, fd, len, pos);
            try {
              const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {Range: `bytes=${pos}-${pos + len}`}
              });
              const bytesRead = response.data.copy(buf);
              process.nextTick(cb, bytesRead);
            } catch (error) {
              console.error('Error reading file:', error);
              process.nextTick(cb, fuse.default.ENOENT);
            }
          },
          read: async (path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (bytesRead?: number) => void) => {
            console.log('read(%s, %d, %d, %d)', path, fd, len, pos);
            try {
              // Fetch the file from the server but only the first time it is read
              if (!readBuffer[path]) {
                console.log(' start the download %s', path);
                const url = `https://v2.shdwdrive.com/${bucketId}${path}`;
                const response = await axios.get(url, {responseType: 'stream'});
                readBuffer[path] = {
                  buffer: Buffer.alloc(0),
                  finished: false,
                  skipped: 0,
                  bytesRead: 0,
                  firstRun: true,
                  started: Date.now()
                };
                response.data.on('data', (chunk: Buffer) => {
                  readBuffer[path].buffer = Buffer.concat([readBuffer[path].buffer, chunk]);
                  if (readBuffer[path].firstRun) {
                    readBuffer[path].firstRun = false;
                    console.log('First Read:', readBuffer[path].buffer.length);
                    const bytesRead = readBuffer[path].buffer.slice(pos, len).copy(buf);
                    process.nextTick(cb, bytesRead);
                  }
                  // console.log('ReadBufferd:', readBuffer[path].buffer.length);
                });
                response.data.on('end', () => {
                  readBuffer[path].finished = true;
                  console.log('finished the download %d', readBuffer[path].buffer.length);
                  let bytes = readBuffer[path].buffer.copy(buf)
                  // console.log('copied %d bytes',bytes);
                  // return cb(bytes);
                });
              } else {
                console.log('reading file, path %s pos %d len: %d', path, pos, len);
                // check if the buffer has enough data to read
                // store skipped in the readBuffer
                let {bytesRead, buffer, finished} = readBuffer[path]
                // if the buffer is not big enough to read the requested length we wait until it is
                let part;
                while (true) {
                  part = readBuffer[path].buffer.slice(pos, pos + len);
                  if (part.length >= len || readBuffer[path].finished) {
                    break;
                  }
                  console.log('waiting for buffer to be big enough, %d (%d)', part.length, buffer.length);
                  await sleep(100); // Adjust the sleep duration as needed
                }
                // Copy chunk to the provided buffer
                const bytes = part.copy(buf);
                console.log('Part Size: %d, BufferSize:%d, BytesToBuf:%d', part.length, buffer.length, bytes);
                process.nextTick(cb, bytes)
                if (finished) {
                  console.log('finished reading file');
                  //show speed of download
                  const timeEnd = Date.now();
                  const timeTaken = timeEnd - readBuffer[path].started;
                  const copiedBytes = buffer.length;
                  const mbPerSecond = calculateTransferRate({timeTaken, buffer: {length: copiedBytes}})
                  console.log(`Time taken:${timeTaken / 1000} seconds, Transfer rate: ${mbPerSecond.toFixed(3)} MB/s`);
                  setTimeout(() => {
                    delete readBuffer[path]
                  }, 600000); // clear buffer after 10 minutes}
                }
              }

            } catch (error) {
              console.error('Error reading file:', error);
              cb(fuse.default.ENOENT);
              delete readBuffer[path];
            }
          },
          release: (path: string, fd: number, cb: (code: number) => void) => {
            // console.log('release(%s, %d)', path, fd);
            // Perform any necessary cleanup here
            openFiles.delete(fd);
            cb(0);
          }
        };
        const fs = new fuse.default(mountpath, ops, {
          allowOther: true,
          mkdir: true,
          force: true,
          displayFolder: 'shdw-drive',
        });
        fs.mount((err) => {
          setInterval(() => {
            invalidateCache();
            getFiles();
          }, 60000);
          if (err) {
            console.error(('Error mounting filesystem:'), err);
            process.exit(1);
          } else {
            console.log((`Filesystem mounted at ${mountpath}`));
          }
        });
        // handle umount command from os

        process.on('SIGINT', () => {
          fs.unmount((err) => {
            if (err) {
              console.error(('Error unmounting filesystem:'), err);
            } else {
              console.log(('Filesystem unmounted'));
            }
            process.exit(1);
          });
        });
      } catch (error) {
        console.error(('Error mounting bucket:'), error);
        process.exit(1);
      }
    });

program.parse(process.argv);
