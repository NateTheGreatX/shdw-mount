
interface TransferInfo {
  timeTaken: number; // in seconds
  buffer: {
    length: number; // in bytes
  };
}



export function calculateTransferRate(info: TransferInfo): number {
  // Convert bytes to megabytes (1 MB = 1,048,576 bytes)
  const fileSizeInMB = info.buffer.length / (1024 * 1024);
  // Calculate transfer rate in MB/s
  return fileSizeInMB / (info.timeTaken / 1000); // This will return the transfer rate in MB/s
}

export async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}