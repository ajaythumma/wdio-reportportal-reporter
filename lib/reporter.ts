import logger from "@wdio/logger";
import Reporter from "@wdio/reporter";
import {createHash} from "crypto";
import * as path from "path";
import * as ReportPortalClient from "reportportal-js-client";
import {CUCUMBER_STATUS, CUCUMBER_TYPE, EVENTS, LEVEL, STATUS, TYPE} from "./constants";
import {EndTestItem, Issue, StartTestItem, StorageEntity} from "./entities";
import ReporterOptions from "./ReporterOptions";
import {Storage} from "./storage";
import {addBrowserParam, isEmpty, isScreenshotCommand, limit, promiseErrorHandler, sendToReporter, getBrowserstackURL} from "./utils";

const log = logger("wdio-reportportal-reporter");

class ReportPortalReporter extends Reporter {

  private get isSynchronised(): boolean {
    return this.rpPromisesCompleted;
  }

  private set isSynchronised(value: boolean) {
    this.rpPromisesCompleted = value;
  }

  public static sendLog(level: LEVEL | keyof typeof LEVEL, message: any) {
    sendToReporter(EVENTS.RP_LOG, {level, message});
  }

  public static sendFile(level: LEVEL | keyof typeof LEVEL, name: string, content: any, type = "image/png") {
    sendToReporter(EVENTS.RP_FILE, {level, name, content, type});
  }

  public static sendLogToTest(test: any, level: LEVEL | keyof typeof LEVEL, message: any) {
    sendToReporter(EVENTS.RP_TEST_LOG, {test, level, message});
  }

  public static sendFileToTest(test: any, level: LEVEL | keyof typeof LEVEL, name: string, content: any, type = "image/png") {
    sendToReporter(EVENTS.RP_TEST_FILE, {test, level, name, content, type});
  }

  public static finishTestManually(test: any) {
    sendToReporter(EVENTS.RP_TEST_RETRY, {test});
  }

  private static reporterName = "reportportal";
  private launchId: string;
  private client: ReportPortalClient;
  private storage = new Storage();
  private tempLaunchId: string;
  private readonly options: ReporterOptions;
  private isMultiremote: boolean;
  private sanitizedCapabilities: string;
  private capabilities: {[key: string]: any};
  private rpPromisesCompleted = true;
  private specFile: string;
  private featureStatus: STATUS;
  private featureName: string;
  private bsUrlPromise= Promise.resolve('');

  constructor(options: any) {
    super(Object.assign({stdout: true}, options));
    this.options = Object.assign(new ReporterOptions(), options);
    this.registerListeners();

    if (this.options.cucumberNestedSteps) {
      this.featureStatus = STATUS.PASSED;
    }
  }

  private onSuiteStart(suite: any) {
    log.trace(`Start suite ${suite.title} ${suite.uid}`);

    const suiteStartObj = this.options.cucumberNestedSteps ?
      new StartTestItem(suite.title, suite.type === CUCUMBER_TYPE.FEATURE ? TYPE.TEST : TYPE.STEP) :
      new StartTestItem(suite.title, TYPE.SUITE);

    if (this.options.cucumberNestedSteps && this.options.autoAttachCucumberFeatureToScenario) {
      switch (suite.type) {
        case CUCUMBER_TYPE.FEATURE:
          this.featureName = suite.title;
          break;
        case CUCUMBER_TYPE.SCENARIO:
          suiteStartObj.attributes = [
            {
              key: CUCUMBER_TYPE.FEATURE,
              value: this.featureName,
            },
          ];
          break;
      }
    }


    if (this.options.useBrowserStack && this.options.cucumberNestedSteps && suite.type === CUCUMBER_TYPE.SCENARIO) {
      // tells report reportal that the test scenario is retry-able
      if (this.options.setRetryTrue) {
        suiteStartObj.retry = true;
      }
      this.bsUrlPromise = getBrowserstackURL(this.capabilities);
    }

    const suiteItem = this.storage.getCurrentSuite();
    let parentId = null;
    if (suiteItem !== null) {
      parentId = suiteItem.id;
    }
    if (this.options.parseTagsFromTestTitle) {
      suiteStartObj.addTags();
      // remove tags from title
      if (this.options.removeTagsFromTestTitle) {
        suiteStartObj.name = suiteStartObj.name.replace(/@(.+): /, '');
      }
    }

    suiteStartObj.description = this.sanitizedCapabilities;

    // add capabilities to tags
    const capabilitiesList = this.options.capabilitiesList;
    if (this.options.attachCapabilities && Array.isArray(capabilitiesList)) {
      for (let [key, value] of Object.entries(this.capabilities)) {
        if (capabilitiesList.includes(key) && value) {
          if (
            key === "deviceName" &&
            this.capabilities.platformName === "Android" &&
            this.options.useBrowserStack
          ) {
            value = this.capabilities.device || `${this.capabilities.deviceManufacturer} ${this.capabilities.deviceModel}`;
          }
          suiteStartObj.attributes.push({
            key,
            value: JSON.stringify(value),
          });
        }
      }
    }
    suiteStartObj.attributes.push()
    const {tempId, promise} = this.client.startTestItem(
      suiteStartObj,
      this.tempLaunchId,
      parentId,
    );
    promiseErrorHandler(promise);
    this.storage.addSuite(new StorageEntity(suiteStartObj.type, tempId, promise, suite));
  }

  private onSuiteEnd(suite: any) {
    log.trace(`End suite ${suite.title} ${suite.uid}`);

    let status = STATUS.PASSED;
    if (this.options.cucumberNestedSteps) {
      switch (suite.type) {
        case CUCUMBER_TYPE.SCENARIO:
          const scenarioStatus = suite.tests.every(({ state }) => state === CUCUMBER_STATUS.PASSED);
          status = scenarioStatus ? STATUS.PASSED : STATUS.FAILED;
          this.featureStatus = this.featureStatus === STATUS.PASSED && status === STATUS.PASSED ? STATUS.PASSED : STATUS.FAILED;
          break;
        case CUCUMBER_TYPE.FEATURE:
          status = this.featureStatus;
          break;
      }
    }

    const suiteItem = this.storage.getCurrentSuite();
    const finishSuiteObj = {status};
    const {promise} = this.client.finishTestItem(suiteItem.id, finishSuiteObj);
    promiseErrorHandler(promise);
    this.storage.removeSuite();
  }

  private onTestStart(test: any, type = TYPE.STEP) {
    log.trace(`Start test ${test.title} ${test.uid}`);
    if (this.storage.getCurrentTest()) {
      return;
    }
    const suite = this.storage.getCurrentSuite();
    const testStartObj = new StartTestItem(test.title, type);
    testStartObj.codeRef = this.specFile;

    if (this.options.cucumberNestedSteps) {
      testStartObj.hasStats = false;
    }
    if (this.options.parseTagsFromTestTitle) {
      testStartObj.addTags();
    }
    if (this.options.setRetryTrue) {
      testStartObj.retry = true;
    }
    addBrowserParam(this.sanitizedCapabilities, testStartObj);

    const {tempId, promise} = this.client.startTestItem(
      testStartObj,
      this.tempLaunchId,
      suite.id,
    );
    promiseErrorHandler(promise);

    this.storage.addTest(test.uid, new StorageEntity(testStartObj.type, tempId, promise, test));
    return promise;
  }

  private onTestPass(test: any) {
    log.trace(`Pass test ${test.title} ${test.uid}`);
    this.testFinished(test, STATUS.PASSED);
  }

  private onTestFail(test: any) {
    log.trace(`Fail test ${test.title} ${test.uid} ${test.error.stack}`);
    const testItem = this.storage.getCurrentTest();
    if (testItem === null) {
      this.onTestStart(test, TYPE.BEFORE_METHOD);
    }
    this.testFinished(test, STATUS.FAILED);
  }

  private onTestSkip(test: any) {
    log.trace(`Skip test ${test.title} ${test.uid}`);
    const testItem = this.storage.getCurrentTest();
    if (testItem === null) {
      this.onTestStart(test);
    }
    this.testFinished(test, STATUS.SKIPPED, new Issue("NOT_ISSUE"));
  }

  private async testFinished(test: any, status: STATUS, issue ?: Issue) {
    log.trace(`Finish test ${test.title} ${test.uid}`);
    const testItem = this.storage.getCurrentTest();
    if (testItem === null) {
      return;
    }

    const finishTestObj = new EndTestItem(status, issue);
    if (status === STATUS.FAILED) {
      const message = `${test.error.stack} `;
      finishTestObj.description = `❌ ${message}`;
      this.client.sendLog(testItem.id, {
        level: LEVEL.ERROR,
        message,
      });

      if (this.options.cucumberNestedSteps) {
        const suiteItem = this.storage.getCurrentSuite();
        this.client.sendLog(suiteItem.id, {
          level: LEVEL.ERROR,
          message,
        });
        if (this.options.useBrowserStack) {
          this.client.sendLog(suiteItem.id, {
            level: LEVEL.ERROR,
            message: await this.bsUrlPromise,
          })
        }
      }
    }

    const {promise} = this.client.finishTestItem(testItem.id, finishTestObj);
    promiseErrorHandler(promise);

    this.storage.removeTest(testItem);
  }

  // @ts-ignore
  private onRunnerStart(runner: any, client: ReportPortalClient) {
    log.trace(`Runner start`);
    this.isSynchronised = false;
    this.isMultiremote = runner.isMultiremote;
    this.sanitizedCapabilities = runner.sanitizedCapabilities;
    this.capabilities = runner.capabilities;
    this.client = client || new ReportPortalClient(this.options.reportPortalClientConfig);
    this.launchId = process.env.RP_LAUNCH_ID;
    this.specFile = runner.specs[0];

    const startLaunchObj = {
      description: this.options.reportPortalClientConfig.description,
      id: this.launchId,
      mode: this.options.reportPortalClientConfig.mode,
      attributes: this.options.reportPortalClientConfig.attributes,
      rerun: this.options.setRetryTrue, // set rerun for the launch
    };
    const {tempId} = this.client.startLaunch(startLaunchObj);
    this.tempLaunchId = tempId;
  }

  private async onRunnerEnd() {
    log.trace(`Runner end`);
    try {
      const finishPromise = await this.client.getPromiseFinishAllItems(this.tempLaunchId);
      log.trace(`Runner end sync ${this.isSynchronised}`);
      return finishPromise;
    } catch (e) {
      log.error("An error occurs on finish test items");
      log.error(e);
    } finally {
      this.isSynchronised = true;
    }
  }
  // @ts-ignore
  private onBeforeCommand(command: any) {
    if (!this.options.reportSeleniumCommands || this.isMultiremote) {
      return;
    }

    const method = `${command.method} ${command.endpoint}`;
    if (!isEmpty(command.body)) {
      const data = JSON.stringify(limit(command.body));
      this.sendLog({message: `${method} ${data}`, level: this.options.seleniumCommandsLogLevel});
    } else {
      this.sendLog({message: `${method}`, level: this.options.seleniumCommandsLogLevel});
    }
  }
  // @ts-ignore
  private onAfterCommand(command: any) {
    if (this.isMultiremote) {
      return;
    }
    const isScreenshot = isScreenshotCommand(command) && command.result.value;
    const {autoAttachScreenshots, screenshotsLogLevel, seleniumCommandsLogLevel, reportSeleniumCommands} = this.options;
    if (isScreenshot) {
      if (autoAttachScreenshots) {
        const obj = {
          content: command.result.value,
          level: screenshotsLogLevel,
          name: "screenshot.png",
        };
        this.sendFile(obj);
      }
    }

    if (reportSeleniumCommands) {
      if (command.body && !isEmpty(command.result.value)) {
        delete command.result.sessionId;
        const data = JSON.stringify(limit(command.result));
        this.sendLog({message: `${data}`, level: seleniumCommandsLogLevel});
      }
    }
  }

  private onHookStart(hook: any) {
    log.trace(`Start hook ${hook.title} ${hook.uid}`);
  }

  private onHookEnd(hook: any) {
    log.trace(`End hook ${hook.title} ${hook.uid} ${JSON.stringify(hook)}`);
    if (hook.error) {
      const testItem = this.storage.getCurrentTest();
      if (testItem === null) {
        this.onTestStart(hook, TYPE.BEFORE_METHOD);
      }
      this.testFinished(hook, STATUS.FAILED);
    }
  }

  private finishTestManually(event: any) {
    const testItem = this.storage.getCurrentTest();
    if (testItem === null) {
      return;
    }
    const err = {
      stack: event.test.error,
    };
    const test = {
      error: err,
      title: testItem.wdioEntity.title,
      uid: testItem.wdioEntity.uid,
    };
    this.testFinished(test, STATUS.FAILED);
  }

  private sendLog(event: any) {
    const testItem = this.storage.getCurrentTest();
    if (testItem === null) {
      log.warn("Cannot send log message. There is no running tests");
      return;
    }

    const {promise} = this.client.sendLog(testItem.id, {
      level: event.level,
      message: String(event.message),
    });
    promiseErrorHandler(promise);
  }

  private sendFile({level, name, content, type = "image/png"}) {
    const testItem = this.storage.getCurrentTest();
    if (!testItem) {
      log.warn(`Can not send file to test. There is no running tests`);
      return;
    }

    const {promise} = this.client.sendLog(testItem.id, {level}, {name, content, type});
    promiseErrorHandler(promise);
  }

  private async sendLogToTest({test, level, message}) {
    const testObj = this.storage.getStartedTests().reverse().find((startedTest) => {
      return startedTest.wdioEntity.title === test.title;
    });

    if (!testObj) {
      log.warn(`Can not send log to test ${test.title}`);
      return;
    }
    const rs = await testObj.promise;

    const saveLogRQ = {
      itemUuid: rs.id,
      launchUuid: this.launchId,
      level,
      message,
      time: this.now(),
    };

    const url = [this.client.baseURL, "log"].join("/");
    const promise = this.client.helpers.getServerResult(url, saveLogRQ, {headers: this.client.headers}, "POST");
    promiseErrorHandler(promise);
  }

  private async sendFileToTest({test, level, name, content, type = "image/png"}) {
    const testObj = this.storage.getStartedTests().reverse().find((startedTest) => {
      return startedTest.wdioEntity.title === test.title;
    });
    if (!testObj) {
      log.warn(`Can not send file to test ${test.title}`);
      return;
    }
    const rs = await testObj.promise;

    const saveLogRQ = {
      itemUuid: rs.id,
      launchUuid: this.launchId,
      level,
      message: "",
      time: this.now(),
    };
    // to avoid https://github.com/BorisOsipov/wdio-reportportal-reporter/issues/42#issuecomment-456573592
    const fileName = createHash("md5").update(name).digest("hex");
    const extension = path.extname(name) || ".dat";
    const promise = this.client.getRequestLogWithFile(saveLogRQ, {name: `${fileName}${extension}`, content, type});
    promiseErrorHandler(promise);
  }

  private registerListeners() {
    // @ts-ignore
    process.on(EVENTS.RP_LOG, this.sendLog.bind(this));
    // @ts-ignore
    process.on(EVENTS.RP_FILE, this.sendFile.bind(this));
    // @ts-ignore
    process.on(EVENTS.RP_TEST_LOG, this.sendLogToTest.bind(this));
    // @ts-ignore
    process.on(EVENTS.RP_TEST_FILE, this.sendFileToTest.bind(this));
    // @ts-ignore
    process.on(EVENTS.RP_TEST_RETRY, this.finishTestManually.bind(this));
  }

  private now() {
    return this.client.helpers.now();
  }
}

export = ReportPortalReporter;
