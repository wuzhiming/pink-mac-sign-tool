const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { globby } = require('globby');
const archiver = require('archiver');
const AdmZip = require('adm-zip');

/**
 * Executes a command and captures its output through a logger.
 */
async function runCommand(cmd, args = [], options = {}, logger = console.log) {
    return new Promise((resolve, reject) => {
        // Only log the command itself, not the sensitive arguments
        logger(`[Executing] ${cmd}`);
        
        const child = spawn(cmd, args, { 
            shell: true, 
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options 
        });

        child.stdout.on('data', (data) => logger(data.toString().trim()));
        child.stderr.on('data', (data) => {
            const out = data.toString().trim();
            // Optional: mask sensitive output if needed, but usually it's in the command args
            logger(`[Output] ${out}`);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command ${cmd} failed with code ${code}.`));
            }
        });
        
        child.on('error', (err) => reject(err));
    });
}

/**
 * Checks if a file is a Mach-O binary (macOS executable/library)
 */
async function isMachOBinary(filePath, logger = console.log) {
    try {
        const { stdout } = await new Promise((resolve, reject) => {
            const child = spawn('file', [filePath], { shell: true });
            let output = '';
            child.stdout.on('data', (data) => output += data.toString());
            child.on('close', (code) => code === 0 ? resolve({ stdout: output }) : reject(new Error(`Exit code ${code}`)));
            child.on('error', reject);
        });

        // Mach-O files will contain "Mach-O" in the output of the `file` command
        const signable = stdout.includes('Mach-O') || stdout.includes('executable');
        if (!signable) {
            logger(`[Skip] ${path.basename(filePath)} is not a signable Mach-O binary.`);
        }
        return signable;
    } catch (error) {
        logger(`[Warning] Could not check file type for ${path.basename(filePath)}: ${error.message}`);
        return false;
    }
}

/**
 * Scan for native binaries in a directory
 */
async function findBinaries(targetPath, logger = console.log) {
    logger(`Scanning ${targetPath} for binaries...`);
    
    // 1. Get all files in the directory (excluding common noise)
    const allFiles = await globby(['**/*'], {
        cwd: targetPath,
        absolute: true,
        onlyFiles: true,
        ignore: [
            '**/.DS_Store', 
            '**/package.json', 
            '**/package-lock.json', 
            '**/node_modules/**',
            '**/temp-notarize.zip',
            '**/temp-notarize-files/**'
        ]
    });

    const candidates = [];

    // 2. Filter all files to find signable binaries
    for (const file of allFiles) {
        const ext = path.extname(file).toLowerCase();
        const name = path.basename(file);
        
        // Match by extension first
        if (['.node', '.dylib', '.app'].includes(ext)) {
            candidates.push(file);
            continue;
        }
        
        // Match by known executable names
        const knownExecutables = [
            'ffprobe', 'ffmpeg', 'FBX-glTF-conv', 'astcenc', 
            'cmftRelease64', 'LightFX', 'composite', 
            'convert', 'etcpack', 'PVRTexToolCLI'
        ];
        if (knownExecutables.includes(name)) {
            candidates.push(file);
            continue;
        }

        // If no extension or unknown name, check if it's a Mach-O binary
        if (ext === '' || ext === '.exe') {
            if (await isMachOBinary(file, logger)) {
                candidates.push(file);
            }
        }
    }
    
    logger(`Found ${candidates.length} signable binaries.`);
    return candidates;
}

/**
 * Sign a list of binaries
 */
async function signBinaries(binaries, logger = console.log) {
    const identity = process.env.APPLE_DEVELOPER_ID || process.env.CODESIGN_IDENTITY;
    if (!identity) {
        throw new Error('Signing identity is required. Please set APPLE_DEVELOPER_ID on the server.');
    }

    for (const binary of binaries) {
        logger(`[Sign] ${path.basename(binary)}`);
        // Ensure executable permissions
        await fs.chmod(binary, 0o755);
        await runCommand('codesign', [
            '--force',
            '--options runtime',
            '--sign', `"${identity}"`,
            `"${binary}"`
        ], {}, logger);
    }
}

/**
 * Notarize binaries
 */
async function notarizeBinaries(binaries, baseDir, logger = console.log) {
    const appleId = process.env.APPLE_ID;
    const appPassword = process.env.APPLE_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appPassword || !teamId) {
        throw new Error('Missing environment variables for notarization: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID');
    }

    logger(`Starting notarization for ${binaries.length} binaries...`);
    const tempZipPath = path.resolve(baseDir, 'temp-notarize.zip');
    const tempDir = path.resolve(baseDir, 'temp-notarize-files');

    try {
        await fs.ensureDir(tempDir);
        for (const binary of binaries) {
            const relativePath = path.relative(baseDir, binary);
            const targetPath = path.join(tempDir, relativePath);
            await fs.ensureDir(path.dirname(targetPath));
            await fs.copy(binary, targetPath);
        }

        logger('Creating ZIP archive for notarization...');
        await createZip(tempDir, tempZipPath);

        logger('Submitting notarization request to Apple...');
        await runCommand('xcrun', [
            'notarytool submit',
            `"${tempZipPath}"`,
            '--apple-id', `"${appleId}"`,
            '--password', `"${appPassword}"`,
            '--team-id', `"${teamId}"`,
            '--wait'
        ], { timeout: 6000000 }, logger);

        logger('Notarization completed successfully!');
    } catch (error) {
        logger(`[Error] Notarization failed: ${error.message}`);
        throw error;
    } finally {
        await fs.remove(tempDir);
        if (await fs.pathExists(tempZipPath)) {
            await fs.remove(tempZipPath);
        }
    }
}

/**
 * Creates a zip file from a directory
 */
async function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

/**
 * Verifies the signature and notarization status of binaries
 */
async function verifyBinaries(binaries, logger = console.log) {
    logger('Starting verification of processed binaries...');
    for (const binary of binaries) {
        logger(`[Verify] ${path.basename(binary)}`);
        try {
            await runCommand('spctl', ['-a', '-vv', `"${binary}"`], {}, logger);
        } catch (error) {
            logger(`[Warning] Verification failed for ${path.basename(binary)}: ${error.message}`);
        }
    }
}

/**
 * Main processing function
 */
async function processBinaries(workingDir, options, logger = console.log) {
    const { sign = true, notarize = true } = options;

    if (process.platform !== 'darwin') {
        throw new Error('This tool only works on macOS.');
    }

    const binaries = await findBinaries(workingDir, logger);
    if (binaries.length === 0) {
        logger('No binaries found to process.');
        return;
    }

    if (sign || notarize) {
        await signBinaries(binaries, logger);
    }

    if (notarize) {
        await notarizeBinaries(binaries, workingDir, logger);
    }

    // Final verification step
    await verifyBinaries(binaries, logger);
}

module.exports = {
    processBinaries,
    createZip,
    unzip: (zipPath, targetDir) => {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(targetDir, true);
    }
};
