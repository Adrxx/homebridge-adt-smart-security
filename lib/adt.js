const events = require('events');
const cheerio = require('cheerio');
const request = require('request-promise');
const nodeCache = require('node-cache');

const HTTPS = 'https://';
const LOGIN_PATH = '/selfcare/j_spring_security_check';
const DASHBOARD_PATH = '/selfcare/dashboard.xhtml';
const FRONTPAGE_PATH = '/selfcare/frontpage.xhtml';
const VIDEO_CONTROLLER_PATH = '/selfcare/rest/videoController';
const STATUS = 'status';

class Adt extends events.EventEmitter {
    constructor(config, log) {
        super();

        this.log = log;
        this.name = config.name;
        this.username = config.username;
        this.password = config.password;
        this.envDomain = config.domain;
        this.cacheTTL = config.cacheTTL || 5;
        this.sensorsToBypass = config.sensorsToBypass || [];

        if (!this.username || !this.password || !this.envDomain) {
            throw new Error('Missing parameter. Please check configuration.');
        }

        this.cookieJar;
        this.loginCookie;
        this.loginCSRFToken;
        this.serverCookie;
        this.csrf_token;
        this.targetState;

        this.viewState;
        this.homeAction;
        this.awayAction;
        this.disarmAction;

        this.log.debug('Initializing with username=%s, password=%s, cacheTTL=%s, domain=%s', this.username, this.password, this.cacheTTL, this.envDomain);

        this.statusCache = new nodeCache({
            stdTTL: this.cacheTTL,
            checkperiod: 1,
            useClones: false
        });

        this.on('error', this.attemptToRecoverFromFailure.bind(this));

        this.init();
    }

    async init() {
        try {
            this.log('Initializing status...');

            this.log.debug('Enabling autoRefresh every %s seconds', this.statusCache.options.stdTTL);

            this.statusCache
                .on('set', (key, state) => {
                    if (state && state.alarm) this.emit('state', state);
                })
                .on('expired', (key) => {
                    this.log.debug(key + ' expired');

                    this.getStatusFromDevice()
                        .then((state) => {
                            this.statusCache.set(STATUS, state);
                        })
                        .catch((error) => {
                            this.log.error('Failed refreshing status. Waiting for recovery.', error.message);
                            this.log.debug(error);
                            this.statusCache.del(STATUS);
                            this.emit('error');
                        });
                });

            await this.login();
            let state = await this.getStatusFromDevice();

            this.statusCache.set(STATUS, state);

            this.log.debug('ADT platform initialized', JSON.stringify(state));

            this.emit('init', state);
        } catch (error) {
            this.log.error('Initialization failed', error);
        }
    }

    getState() {
        return this.statusCache.get(STATUS);
    }

    setState(status) {
        this.targetState = status;

        let currentStatus = this.getState();

        if (currentStatus && currentStatus.alarm) {
            if (currentStatus.alarm.armingState === status) {
                this.log.debug('No status change needed');
                this.targetState = undefined;

                return null;
            } else if (currentStatus.alarm.armingState === 3 && currentStatus.alarm.faultStatus === 1 && !this.isBypassable()) {
                this.log.error("Can't arm system. System is not ready.");
                this.targetState = undefined;

                return new Error("Can't arm system. System is not ready.");
            }
        }

        this.log('Setting status to', status);
        this.sendStateToDevice(status);

        return null;
    }

    isBypassable() {
        let currentState = this.getState();
        return !currentState || currentState.contactSensors.filter(sensor => !sensor.status).every(sensor => this.sensorsToBypass.indexOf(sensor.name) > -1);
    }

    async login() {
        this.cookieJar = new request.jar();

        let options = {
            jar: this.cookieJar,
            uri: HTTPS + this.envDomain,
            resolveWithFullResponse: true,
            headers: {
                'Host': this.envDomain,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
                'Expires': -1,
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive'
            }
        };

        await request(options)
            .then((response) => {
                if (response.headers['set-cookie']) {
                    this.loginCookie = response.headers['set-cookie'].filter(cookie => cookie.startsWith('JSESSION'))[0];
                    this.loginCookie = this.loginCookie.substring(0, this.loginCookie.indexOf(';'));
                    this.serverCookie = response.headers['set-cookie'].filter(cookie => cookie.startsWith('BIGipServerTYCO'))[0];
                    this.serverCookie = this.serverCookie.substring(0, this.serverCookie.indexOf(';'));
                    this.loginCSRFToken = cheerio.load(response.body)('input[name=_csrf]').val();
                }
            });

        this.log.debug('Using username', this.username);
        this.log.debug('Using password', this.password);
        this.log.debug('Obtained login cookie', this.loginCookie);
        this.log.debug('Obtained CSRF login token', this.loginCSRFToken);
        this.log.debug('Obtained server cookie', this.serverCookie);

        options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + LOGIN_PATH,
            resolveWithFullResponse: true,
            followAllRedirects: true,
            form: {
                'j_username': this.username,
                'j_password': this.password,
                'loginButton': 'Ir',
                '_csrf': this.loginCSRFToken
            },
            headers: {
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + FRONTPAGE_PATH,
                'Host': this.envDomain,
                'Cookie': this.loginCookie + '; ' + this.serverCookie,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
                'Expires': -1,
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive'
            }
        };

        let response = await request(options);

        this.csrf_token = cheerio.load(response.body)('input[name=_csrf]').val();
        this.log.debug('Got CSRF Token', this.csrf_token);

        if (this.csrf_token === this.loginCSRFToken) {
            throw new Error('Login failed. Please check supplied credentials');
        }

        this.log('Logged in as', this.username);
    }

    async getStatusFromDevice() {
        let state = {
            alarm: {},
            contactSensors: [],
            cameras: []
        };

        let options = {
            jar: this.cookieJar,
            uri: HTTPS + this.envDomain + DASHBOARD_PATH,
            headers: {
                'X-CSRF-TOKEN': this.csrf_token,
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
                'Expires': -1,
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive'
            }
        };

        this.log.debug('Fetching status...');

        await request(options)
            .then((response) => {
                let $ = cheerio.load(response);

                //Alarm

                let activeButton = $('#activationButtons .active');
                let notReady = $('#activationButtons .OFF_NOT_READY');
                let batteryLevel = $('#j_idt135\\3A batteryLevelPanel');

                this.systemReady = true;

                if (activeButton.hasClass('left')) {
                    state.alarm.armingState = 3; // DISARMED
                } else if (activeButton.hasClass('center')) {
                    state.alarm.armingState = 0; // HOME
                } else if (activeButton.hasClass('right')) {
                    state.alarm.armingState = 1; // AWAY
                } else if (notReady.hasClass('left')) {
                    state.alarm.armingState = 3; // DISARMED
                    state.alarm.faultStatus = 1;  // NOT READY
                    this.systemReady = false;
                }

                state.alarm.lowBatteryStatus = 0;

                if (batteryLevel.hasClass('lev1')) {
                    state.alarm.batteryLevel = 10;
                    state.alarm.lowBatteryStatus = 1;
                } else if (batteryLevel.hasClass('lev2')) {
                    state.alarm.batteryLevel = 50;
                } else {
                    state.alarm.batteryLevel = 100;
                }

                // Contact sensors

                $('.openDoorDash').each((index, element) => {
                    let contactSensor = {
                        name: element.parent.attribs.title,
                        status: element.attribs.class.endsWith('off')
                    };

                    state.contactSensors.push(contactSensor);
                });

                // Actions

                this.viewState = $('input[type=hidden][name=javax\\.faces\\.ViewState]').val();
                this.homeAction = $('#activationButtons li.center a[title]').attr('id');
                this.awayAction = $('#activationButtons li.right a[title]').attr('id');
                this.disarmAction = $('#activationButtons li.left a[title]').attr('id');

                this.bypassableSensorActions = $('.protección span .dashboardDevice .turning').children()
                    .filter((sensorIndex, sensor) => this.sensorsToBypass.indexOf(sensor.attribs.title) > -1)
                    .map((sensorIndex, sensor) => sensor.parent)
                    .map((sensorIndex, sensor) => sensor.children)
                    .filter((sensorIndex, sensor) => sensor.attribs && sensor.attribs.style && sensor.attribs.style.indexOf('display: flex') > -1)
                    .map((sensorIndex, sensor) => sensor.children)
                    .filter((sensorIndex, sensor) => sensor.attribs && sensor.attribs.class && sensor.attribs.class.indexOf('deviceActivationButtons1') > -1)
                    .map((sensorIndex, sensor) => sensor.children)
                    .filter((sensorIndex, sensor) => sensor.attribs && sensor.attribs.class && sensor.attribs.class.indexOf('bypass-link') > -1)
                    .map((sensorIndex, sensor) => sensor.attribs.id)
                    .toArray();

                if (state.alarm.armingState === undefined) {
                    this.log.debug(response);
                    throw new Error('Unexpected status response.');
                }

                $('.cameraViewer.cameraThumbnail').each((index, element) => {
                    let cameraId = (element.attribs.id.split('_')[1]);
                    let cameraName = element.children.find((child) => child.attribs && child.attribs.class === 'name').attribs.title;

                    state.cameras.push({
                        id: cameraId,
                        name: cameraName
                    })
                });
            });

        state.alarm.targetState = this.targetState !== undefined ? this.targetState : state.alarm.armingState;

        this.log.debug('Got status', JSON.stringify(state));

        return state;
    }

    async attemptToRecoverFromFailure() {
        try {
            this.log.warn('Attempting failure recovery');

            await this.login();
            this.statusCache.set(STATUS, await this.getStatusFromDevice());

            this.log.info('Recovered from error');
        } catch (error) {
            this.log.warn('Still failing', error.message);
            this.log.debug(error);
            setTimeout(() => this.emit('error'), 3000);
        }
    }

    async sendStateToDevice(state) {
        let action;

        switch (state) {
            case 0:
                action = this.homeAction;
                break;
            case 1:
                action = this.awayAction;
                break;
            case 3:
                action = this.disarmAction;
                break;
            default:
                throw new Error('Mode not supported');
        }

        this.targetState = state;

        this.log.debug('Stopping auto refresh');
        this.statusCache.del(STATUS);

        if ((state === 0 || state === 1) && !this.systemReady) {
            await this.bypassSensors();
        }

        this.execute(action)
            .then(() => {
                this.log('Status set to', this.targetState);

                setTimeout(() => {
                    if (this.targetState === state) {
                        this.targetState = undefined;
                        this.log.debug('Target state reset');
                    }
                }, 20000);
            })
            .catch((error) => {
                this.log.error('Error while setting state to', state, error);
                this.targetState = undefined;
            })
            .finally(async () => {
                this.log.debug('Resuming auto refresh');
                this.statusCache.set(STATUS, await this.getStatusFromDevice(), 1);
            });
    }

    async bypassSensors() {
        this.log.warn('Bypassing sensors');
        let bypasses = [];
        this.bypassableSensorActions.forEach(sensor => bypasses.push(this.execute(sensor)));

        await Promise.all(bypasses);
        await setTimeout(() => this.log.warn('Bypassing done'), 1000);
    }

    execute(action) {
        this.log.debug('Executing', action);

        let options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + DASHBOARD_PATH,
            form: {
                'selfCareForm': 'selfCareForm',
                'dummy': '',
                '_csrf': this.csrf_token,
                'javax.faces.ViewState': this.viewState,
                'javax.faces.source': action,
                'javax.faces.partial.event': 'click',
                'javax.faces.partial.execute': action + ' ' + action,
                'javax.faces.behavior.event': 'action',
                'javax.faces.partial.ajax': true
            },
            headers: {
                'Accept': '*/*',
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'Faces-Request': 'partial/ajax',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
                'Expires': -1,
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive'
            }
        };

        return request(options);
    }

    startFeed(cameraId) {
        this.log.debug('Getting stream for camera', cameraId);

        let options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + VIDEO_CONTROLLER_PATH + '/startVideo',
            body: {
                deviceId: cameraId
            },
            json: true,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive',
                'X-CSRF-TOKEN': this.csrf_token,
                'X-Requested-With': 'XMLHttpRequest'
            }
        };

        return request(options);
    }

    stopFeed(cameraId) {
        this.log.debug('Stopping stream for camera', cameraId);

        let options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + VIDEO_CONTROLLER_PATH + '/stopVideo',
            body: {
                deviceId: cameraId
            },
            json: true,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive',
                'X-CSRF-TOKEN': this.csrf_token,
                'X-Requested-With': 'XMLHttpRequest'
            }
        };

        return request(options);
    }

    getImage(cameraId) {
        this.log.debug('Getting still image for camera', cameraId);

        let options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + VIDEO_CONTROLLER_PATH + '/getImageSnapshot',
            body: {
                deviceId: cameraId
            },
            json: true,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive',
                'X-CSRF-TOKEN': this.csrf_token,
                'X-Requested-With': 'XMLHttpRequest'
            }
        };

        return request(options);
    }

    getExistingImage(cameraId) {
        this.log.debug('Getting still image for camera', cameraId);

        let options = {
            jar: this.cookieJar,
            method: 'POST',
            uri: HTTPS + this.envDomain + VIDEO_CONTROLLER_PATH + '/getExistingImage',
            body: {
                deviceId: cameraId
            },
            json: true,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Origin': HTTPS + this.envDomain,
                'Referer': HTTPS + this.envDomain + DASHBOARD_PATH,
                'Host': this.envDomain,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36',
                'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
                'Accept-Encoding': 'br, gzip, deflate',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
                'Connection': 'keep-alive',
                'X-CSRF-TOKEN': this.csrf_token,
                'X-Requested-With': 'XMLHttpRequest'
            }
        };

        return request(options);
    }
}

module.exports = {
    Adt
};
