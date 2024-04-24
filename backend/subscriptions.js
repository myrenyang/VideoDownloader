const fs = require('fs-extra');
const path = require('path');
const youtubedl = require('youtube-dl');

const config_api = require('./config');
const archive_api = require('./archive');
const utils = require('./utils');
const logger = require('./logger');
const CONSTS = require('./consts');

const debugMode = process.env.YTDL_MODE === 'debug';

const db_api = require('./db');
const downloader_api = require('./downloader');

exports.subscribe = async (sub, user_uid = null, skip_get_info = false) => {
    const result_obj = {
        success: false,
        error: ''
    };
    return new Promise(async resolve => {
        // sub should just have url and name. here we will get isPlaylist and path
        sub.isPlaylist = sub.isPlaylist || sub.url.includes('playlist');
        sub.videos = [];

        let url_exists = !!(await db_api.getRecord('subscriptions', {url: sub.url, user_uid: user_uid}));

        if (!sub.name && url_exists) {
            logger.error(`Sub with the same URL "${sub.url}" already exists -- please provide a custom name for this new subscription.`);
            result_obj.error = 'Subcription with URL ' + sub.url + ' already exists! Custom name is required.';
            resolve(result_obj);
            return;
        }

        sub['user_uid'] = user_uid ? user_uid : undefined;
        await db_api.insertRecordIntoTable('subscriptions', sub);

        let success = skip_get_info ? true : await getSubscriptionInfo(sub);
        exports.writeSubscriptionMetadata(sub);

        if (success) {
            if (!sub.paused) exports.getVideosForSub(sub, user_uid);
        } else {
            logger.error('Subscribe: Failed to get subscription info. Subscribe failed.')
        }

        result_obj.success = success;
        result_obj.sub = sub;
        resolve(result_obj);
    });

}

async function getSubscriptionInfo(sub) {
    // get videos
    let downloadConfig = ['--dump-json', '--playlist-end', '1'];
    let useCookies = config_api.getConfigItem('ytdl_use_cookies');
    if (useCookies) {
        if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
            downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
        } else {
            logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
        }
    }

    return new Promise(async resolve => {
        youtubedl.exec(sub.url, downloadConfig, {maxBuffer: Infinity}, async (err, output) => {
            if (debugMode) {
                logger.info('Subscribe: got info for subscription ' + sub.id);
            }
            if (err) {
                logger.error(err.stderr);
                resolve(false);
            } else if (output) {
                if (output.length === 0 || (output.length === 1 && output[0] === '')) {
                    logger.verbose('Could not get info for ' + sub.id);
                    resolve(false);
                }
                for (let i = 0; i < output.length; i++) {
                    let output_json = null;
                    try {
                        output_json = JSON.parse(output[i]);
                    } catch(e) {
                        output_json = null;
                    }
                    if (!output_json) {
                        continue;
                    }
                    if (!sub.name) {
                        if (sub.isPlaylist) {
                            sub.name = output_json.playlist_title ? output_json.playlist_title : output_json.playlist;
                        } else {
                            sub.name = output_json.uploader;
                        }
                        // if it's now valid, update
                        if (sub.name) {
                            let sub_name = sub.name;
                            const sub_name_exists = await db_api.getRecord('subscriptions', {name: sub.name, isPlaylist: sub.isPlaylist, user_uid: sub.user_uid});
                            if (sub_name_exists) sub_name += ` - ${sub.id}`;
                            await db_api.updateRecord('subscriptions', {id: sub.id}, {name: sub_name});
                        }
                    }

                    // TODO: get even more info

                    resolve(true);
                }
                resolve(false);
            }
        });
    });
}

exports.unsubscribe = async (sub, deleteMode, user_uid = null) => {
    let basePath = null;
    if (user_uid)
        basePath = path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions');
    else
        basePath = config_api.getConfigItem('ytdl_subscriptions_base_path');

    let id = sub.id;

    const sub_files = await db_api.getRecords('files', {sub_id: id});
    for (let i = 0; i < sub_files.length; i++) {
        const sub_file = sub_files[i];
        if (config_api.descriptors[sub_file['uid']]) {
            try {
                for (let i = 0; i < config_api.descriptors[sub_file['uid']].length; i++) {
                    config_api.descriptors[sub_file['uid']][i].destroy();
                }
            } catch(e) {
                continue;
            }
        }
    }

    await db_api.removeRecord('subscriptions', {id: id});
    await db_api.removeAllRecords('files', {sub_id: id});

    // failed subs have no name, on unsubscribe they shouldn't error
    if (!sub.name) {
        return;
    }

    const appendedBasePath = getAppendedBasePath(sub, basePath);
    if (deleteMode && (await fs.pathExists(appendedBasePath))) {
        await fs.remove(appendedBasePath);
    }

    await db_api.removeAllRecords('archives', {sub_id: sub.id});
}

exports.deleteSubscriptionFile = async (sub, file, deleteForever, file_uid = null, user_uid = null) => {
    if (typeof sub === 'string') {
        // TODO: fix bad workaround where sub is a sub_id
        sub = await db_api.getRecord('subscriptions', {sub_id: sub});
    }
    // TODO: combine this with deletefile
    let basePath = null;
    basePath = user_uid ? path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions')
                        : config_api.getConfigItem('ytdl_subscriptions_base_path');
    const appendedBasePath = getAppendedBasePath(sub, basePath);
    const name = file;
    let retrievedID = null;
    let retrievedExtractor = null;

    await db_api.removeRecord('files', {uid: file_uid});

    let filePath = appendedBasePath;
    const ext = (sub.type && sub.type === 'audio') ? '.mp3' : '.mp4'
    var jsonPath = path.join(__dirname,filePath,name+'.info.json');
    var videoFilePath = path.join(__dirname,filePath,name+ext);
    var imageFilePath = path.join(__dirname,filePath,name+'.jpg');
    var altImageFilePath = path.join(__dirname,filePath,name+'.webp');

    const [jsonExists, videoFileExists, imageFileExists, altImageFileExists] = await Promise.all([
        fs.pathExists(jsonPath),
        fs.pathExists(videoFilePath),
        fs.pathExists(imageFilePath),
        fs.pathExists(altImageFilePath),
    ]);

    if (jsonExists) {
        const info_json = fs.readJSONSync(jsonPath);
        retrievedID = info_json['id'];
        retrievedExtractor = info_json['extractor'];
        await fs.unlink(jsonPath);
    }

    if (imageFileExists) {
        await fs.unlink(imageFilePath);
    }

    if (altImageFileExists) {
        await fs.unlink(altImageFilePath);
    }

    if (videoFileExists) {
        await fs.unlink(videoFilePath);
        if ((await fs.pathExists(jsonPath)) || (await fs.pathExists(videoFilePath))) {
            return false;
        } else {
            // check if the user wants the video to be redownloaded (deleteForever === false)
            if (deleteForever) {
                // ensure video is in the archives
                const exists_in_archive = await archive_api.existsInArchive(retrievedExtractor, retrievedID, sub.type, user_uid, sub.id);
                if (!exists_in_archive) {
                    await archive_api.addToArchive(retrievedExtractor, retrievedID, sub.type, file.title, user_uid, sub.id);
                }
            } else {
                await archive_api.removeFromArchive(retrievedExtractor, retrievedID, sub.type, user_uid, sub.id);
            }
            return true;
        }
    } else {
        // TODO: tell user that the file didn't exist
        return true;
    }
}

exports.getVideosForSub = async (sub, user_uid = null) => {
    const latest_sub_obj = await exports.getSubscription(sub.id);
    if (!latest_sub_obj || latest_sub_obj['downloading']) {
        return false;
    }

    updateSubscriptionProperty(sub, {downloading: true}, user_uid);

    // get basePath
    let basePath = null;
    if (user_uid)
        basePath = path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions');
    else
        basePath = config_api.getConfigItem('ytdl_subscriptions_base_path');

    let appendedBasePath = getAppendedBasePath(sub, basePath);
    fs.ensureDirSync(appendedBasePath);

    const downloadConfig = await generateArgsForSubscription(sub, user_uid);

    // get videos
    logger.verbose(`Subscription: getting list of videos to download for ${sub.name} with args: ${downloadConfig.join(',')}`);

    return new Promise(async resolve => {
        youtubedl.exec(sub.url, downloadConfig, {maxBuffer: Infinity}, async function(err, output) {
            // cleanup
            updateSubscriptionProperty(sub, {downloading: false}, user_uid);

            // remove temporary archive file if it exists
            const archive_path = path.join(appendedBasePath, 'archive.txt');
            const archive_exists = await fs.pathExists(archive_path);
            if (archive_exists) {
                await fs.unlink(archive_path);
            }

            logger.verbose('Subscription: finished check for ' + sub.name);
            const processed_output = utils.parseOutputJSON(output, err);
            if (!processed_output) {
                logger.error('Subscription check failed!');
                resolve(null);
                return;
            }
            const files_to_download = await handleOutputJSON(processed_output, sub, user_uid);
            resolve(files_to_download);
            return;
        });
    }, err => {
        logger.error(err);
        updateSubscriptionProperty(sub, {downloading: false}, user_uid);
    });
}

async function handleOutputJSON(output_jsons, sub, user_uid) {
    if (config_api.getConfigItem('ytdl_subscriptions_redownload_fresh_uploads')) {
        await setFreshUploads(sub, user_uid);
        checkVideosForFreshUploads(sub, user_uid);
    }

    if (output_jsons.length === 0 || (output_jsons.length === 1 && output_jsons[0] === '')) {
        logger.verbose('No additional videos to download for ' + sub.name);
        return [];
    }

    const files_to_download = await getFilesToDownload(sub, output_jsons);
    const base_download_options = exports.generateOptionsForSubscriptionDownload(sub, user_uid);

    for (let j = 0; j < files_to_download.length; j++) {
        const file_to_download = files_to_download[j];
        file_to_download['formats'] = utils.stripPropertiesFromObject(file_to_download['formats'], ['format_id', 'filesize', 'filesize_approx']);  // prevent download object from blowing up in size
        await downloader_api.createDownload(file_to_download['webpage_url'], sub.type || 'video', base_download_options, user_uid, sub.id, sub.name, file_to_download);
    }

    return files_to_download;
}

exports.generateOptionsForSubscriptionDownload = (sub, user_uid) => {
    let basePath = null;
    if (user_uid)
        basePath = path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions');
    else
        basePath = config_api.getConfigItem('ytdl_subscriptions_base_path');

    let default_output = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';

    const base_download_options = {
        maxHeight: sub.maxQuality && sub.maxQuality !== 'best' ? sub.maxQuality : null,
        customFileFolderPath: getAppendedBasePath(sub, basePath),
        customOutput: sub.custom_output ? `${sub.custom_output}` : `${default_output}`,
        customArchivePath: path.join(basePath, 'archives', sub.name),
        additionalArgs: sub.custom_args
    }

    return base_download_options;
}

async function generateArgsForSubscription(sub, user_uid, redownload = false, desired_path = null) {
    // get basePath
    let basePath = null;
    if (user_uid)
        basePath = path.join(config_api.getConfigItem('ytdl_users_base_path'), user_uid, 'subscriptions');
    else
        basePath = config_api.getConfigItem('ytdl_subscriptions_base_path');

    let appendedBasePath = getAppendedBasePath(sub, basePath);

    const file_output = config_api.getConfigItem('ytdl_default_file_output') ? config_api.getConfigItem('ytdl_default_file_output') : '%(title)s';

    let fullOutput = `"${appendedBasePath}/${file_output}.%(ext)s"`;
    if (desired_path) {
        fullOutput = `"${desired_path}.%(ext)s"`;
    } else if (sub.custom_output) {
        fullOutput = `"${appendedBasePath}/${sub.custom_output}.%(ext)s"`;
    }

    let downloadConfig = ['--dump-json', '-o', fullOutput, !redownload ? '-ciw' : '-ci', '--write-info-json', '--print-json'];

    let qualityPath = null;
    if (sub.type && sub.type === 'audio') {
        qualityPath = ['-f', 'bestaudio']
        qualityPath.push('-x');
        qualityPath.push('--audio-format', 'mp3');
    } else {
        if (!sub.maxQuality || sub.maxQuality === 'best') qualityPath = ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4'];
        else qualityPath = ['-f', `bestvideo[height<=${sub.maxQuality}]+bestaudio/best[height<=${sub.maxQuality}]`, '--merge-output-format', 'mp4'];
    }

    downloadConfig.push(...qualityPath)

    // skip videos that are in the archive. otherwise sub download can be permanently slow (vs. just the first time)
    const archive_text = await archive_api.generateArchive(sub.type, sub.user_uid, sub.id);
    const archive_count = archive_text.split('\n').length - 1;
    if (archive_count > 0) {
        logger.verbose(`Generating temporary archive file for subscription ${sub.name} with ${archive_count} entries.`)
        const archive_path = path.join(appendedBasePath, 'archive.txt');
        await fs.writeFile(archive_path, archive_text);
        downloadConfig.push('--download-archive', archive_path);
    }

    if (sub.custom_args) {
        const customArgsArray = sub.custom_args.split(',,');
        if (customArgsArray.indexOf('-f') !== -1) {
            // if custom args has a custom quality, replce the original quality with that of custom args
            const original_output_index = downloadConfig.indexOf('-f');
            downloadConfig.splice(original_output_index, 2);
        }
        downloadConfig.push(...customArgsArray);
    }

    if (sub.timerange && !redownload) {
        downloadConfig.push('--dateafter', sub.timerange);
    }

    let useCookies = config_api.getConfigItem('ytdl_use_cookies');
    if (useCookies) {
        if (await fs.pathExists(path.join(__dirname, 'appdata', 'cookies.txt'))) {
            downloadConfig.push('--cookies', path.join('appdata', 'cookies.txt'));
        } else {
            logger.warn('Cookies file could not be found. You can either upload one, or disable \'use cookies\' in the Advanced tab in the settings.');
        }
    }

    if (config_api.getConfigItem('ytdl_include_thumbnail')) {
        downloadConfig.push('--write-thumbnail');
    }

    const rate_limit = config_api.getConfigItem('ytdl_download_rate_limit');
    if (rate_limit && downloadConfig.indexOf('-r') === -1 && downloadConfig.indexOf('--limit-rate') === -1) {
        downloadConfig.push('-r', rate_limit);
    }

    const default_downloader = utils.getCurrentDownloader() || config_api.getConfigItem('ytdl_default_downloader');
    if (default_downloader === 'yt-dlp') {
        downloadConfig.push('--no-clean-info-json');
    }

    downloadConfig = utils.filterArgs(downloadConfig, ['--write-comments']);

    return downloadConfig;
}

async function getFilesToDownload(sub, output_jsons) {
    const files_to_download = [];
    for (let i = 0; i < output_jsons.length; i++) {
        const output_json = output_jsons[i];
        const file_missing = !(await db_api.getRecord('files', {sub_id: sub.id, url: output_json['webpage_url']})) && !(await db_api.getRecord('download_queue', {sub_id: sub.id, url: output_json['webpage_url'], error: null, finished: false}));
        if (file_missing) {
            const file_with_path_exists = await db_api.getRecord('files', {sub_id: sub.id, path: output_json['_filename']});
            if (file_with_path_exists) {
                // or maybe just overwrite???
                logger.info(`Skipping adding file ${output_json['_filename']} for subscription ${sub.name} as a file with that path already exists.`)
                continue;
            }
            const exists_in_archive = await archive_api.existsInArchive(output_json['extractor'], output_json['id'], sub.type, sub.user_uid, sub.id);
            if (exists_in_archive) continue;

            files_to_download.push(output_json);
        }
    }
    return files_to_download;
}


exports.getSubscriptions = async (user_uid = null) => {
    return await db_api.getRecords('subscriptions', {user_uid: user_uid});
}

exports.getAllSubscriptions = async () => {
    const all_subs = await db_api.getRecords('subscriptions');
    const multiUserMode = config_api.getConfigItem('ytdl_multi_user_mode');
    return all_subs.filter(sub => !!(sub.user_uid) === !!multiUserMode);
}

exports.getSubscription = async (subID) => {
    // stringify and parse because we may override the 'downloading' property
    const sub = JSON.parse(JSON.stringify(await db_api.getRecord('subscriptions', {id: subID})));
    // now with the download_queue, we may need to override 'downloading'
    const current_downloads = await db_api.getRecords('download_queue', {running: true, sub_id: subID}, true);
    if (!sub['downloading']) sub['downloading'] = current_downloads > 0;
    return sub;
}

exports.getSubscriptionByName = async (subName, user_uid = null) => {
    return await db_api.getRecord('subscriptions', {name: subName, user_uid: user_uid});
}

exports.updateSubscription = async (sub) => {
    await db_api.updateRecord('subscriptions', {id: sub.id}, sub);
    exports.writeSubscriptionMetadata(sub);
    return true;
}

exports.updateSubscriptionPropertyMultiple = async (subs, assignment_obj) => {
    subs.forEach(async sub => {
        await updateSubscriptionProperty(sub, assignment_obj);
    });
}

async function updateSubscriptionProperty(sub, assignment_obj) {
    // TODO: combine with updateSubscription
    await db_api.updateRecord('subscriptions', {id: sub.id}, assignment_obj);
    return true;
}

exports.writeSubscriptionMetadata = (sub) => {
    let basePath = sub.user_uid ? path.join(config_api.getConfigItem('ytdl_users_base_path'), sub.user_uid, 'subscriptions')
                                : config_api.getConfigItem('ytdl_subscriptions_base_path');
    const appendedBasePath = getAppendedBasePath(sub, basePath);
    const metadata_path = path.join(appendedBasePath, CONSTS.SUBSCRIPTION_BACKUP_PATH);
    fs.writeJSONSync(metadata_path, sub);
}

async function setFreshUploads(sub) {
    const sub_files = await db_api.getRecords('files', {sub_id: sub.id});
    if (!sub_files) return;
    const current_date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    sub_files.forEach(async file => {
        if (current_date === file['upload_date'].replace(/-/g, '')) {
            // set upload as fresh
            const file_uid = file['uid'];
            await db_api.setVideoProperty(file_uid, {'fresh_upload': true});
        }
    });
}

async function checkVideosForFreshUploads(sub, user_uid) {
    const sub_files = await db_api.getRecords('files', {sub_id: sub.id});
    const current_date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    sub_files.forEach(async file => {
        if (file['fresh_upload'] && current_date > file['upload_date'].replace(/-/g, '')) {
            await checkVideoIfBetterExists(file, sub, user_uid)
        }
    });
}

async function checkVideoIfBetterExists(file_obj, sub, user_uid) {
    const new_path = file_obj['path'].substring(0, file_obj['path'].length - 4);
    const downloadConfig = await generateArgsForSubscription(sub, user_uid, true, new_path);
    logger.verbose(`Checking if a better version of the fresh upload ${file_obj['id']} exists.`);
    // simulate a download to verify that a better version exists
    youtubedl.getInfo(file_obj['url'], downloadConfig, async (err, output) => {
        if (err) {
            // video is not available anymore for whatever reason
        } else if (output) {
            const metric_to_compare = sub.type === 'audio' ? 'abr' : 'height';
            if (output[metric_to_compare] > file_obj[metric_to_compare]) {
                // download new video as the simulated one is better
                youtubedl.exec(file_obj['url'], downloadConfig, {maxBuffer: Infinity}, async (err, output) => {
                    if (err) {
                        logger.verbose(`Failed to download better version of video ${file_obj['id']}`);
                    } else if (output) {
                        logger.verbose(`Successfully upgraded video ${file_obj['id']}'s ${metric_to_compare} from ${file_obj[metric_to_compare]} to ${output[metric_to_compare]}`);
                        await db_api.setVideoProperty(file_obj['uid'], {[metric_to_compare]: output[metric_to_compare]});
                    }
                });
            } 
        }
    });
    await db_api.setVideoProperty(file_obj['uid'], {'fresh_upload': false});
}

// helper functions

function getAppendedBasePath(sub, base_path) {
    return path.join(base_path, (sub.isPlaylist ? 'playlists/' : 'channels/'), sub.name);
}
