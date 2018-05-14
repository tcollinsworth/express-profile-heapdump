const express = require('express')
const compression = require('compression')

const heapdump = require('heapdump')
const profiler = require('v8-profiler')

const fs = require('fs')
const os = require('os')

const ENABLE = (process.env.PROFILING_HEAPDUMP_ENABLED || 'false').toLowerCase() === 'true'

const BASIC_AUTH_USER = process.env.PROFILING_HEAPDUMP_BASIC_AUTH_USER || 'change' //change:me base64 encoded = Y2hhbmdlOm1l
const BASIC_AUTH_PASSWORD = process.env.PROFILING_HEAPDUMP_BASIC_AUTH_PASSWORD || 'me'

const HOST = process.env.PROFILING_HEAPDUMP_HOST || 'localhost'
const PORT = process.env.PROFILING_HEAPDUMP_PORT || '6660'

const PROFILING_DURATION_SEC_DEFAULT = parseInt(process.env.PROFILING_DURATION_SEC_DEFAULT || '300', 10) // 5 min

//http://man7.org/linux/man-pages/man7/signal.7.html
const PROFILING_SIGNAL = process.env.PROFILING_SIGNAL || 'SIGUSR1' // SIGUSR1 = 30,10,16
const HEAPDUMP_SIGNAL = process.env.HEAPDUMP_SIGNAL || 'SIGUSR2' // SIGUSR2 = 31,12,17

process.env.NODE_HEAPDUMP_OPTIONS='nosignal' // disable default heapdump SIGUSR2 so we can override it and control filename

const router = express.Router()
//export router for adding to existing express service
//client is responsible for protecting, authenticating/authorizing access
exports.default = router

let serviceStarted = false
let profilingDurationSec = PROFILING_DURATION_SEC_DEFAULT

let profileSampleRateUs = 1000 //default

let profilingInProgress = false
let heapdumpInProgress = false

let heapdumpFilename
let profileStartTs
let profileFilename

//using only GET so it works via browser URL and one less argument via curl
router.get('/heapdump', doHeapdump)

router.get('/profile/rate/:rate', setSamplingRate)
router.get('/profile/start', startProfilingReq)
router.get('/profile/stop', stopProfilingReq)

//rest list *.heapsnapshot, *.cpuprofile
//rest delete xxx.heapsnapshot or xxx.cpuprofile
//curl download with compression *.heapsnapshot, *.cpuprofile

router.get('/list', listFiles) //TODO only specific files, no paths
router.get('/targz', targzFiles) //TODO all, or specified, only specific files, no paths
router.get('/download/:filename', downloadFile) //TODO only specific file, no paths
router.get('/delete', deleteFiles) //TODO all or only specific files, no paths

// Initializes stand-alone express service and initializes the default basic auth or calls a passed in custom authentication function
function startService(initAuth) {
  if (serviceStarted) {
    return
  }
  if (!ENABLE) {
    process.stdout.write(`PROFILING_HEAPDUMP_ENABLED '${process.env.PROFILING_HEAPDUMP_ENABLED}', not enabling on ${os.hostname()}:${PORT}\n`)
    return
  }
  const app = express()

  if (initAuth != null) {
    initAuth(app, router)
  } else (
    initBasicAuth(app, router)
  )

  app
    .listen(PORT, HOST, () => {
      process.stdout.write(`Profiling/heapdumps enabled listening on ${os.hostname()}:${PORT}\n`)
    })
    .on('error', err => {
      process.stdout.write(
        `Error occurred, profiling/heapdumps disabled on ${os.hostname()}:${PORT}: ${err}\n`
      )
    })
  serviceStarted = true
}

//TODO express-rate-limit

// Default basic auth initialization, can be overriden
function initBasicAuth(app, router) {
  const passport = require('passport')
  const BasicStrategy = require('passport-http').BasicStrategy

  if (BASIC_AUTH_USER === 'change' || BASIC_AUTH_PASSWORD === 'me') {
    process.stdout.write(`WARNING: change the following environment vars in production on ${os.hostname()}:${PORT}: PROFILING_HEAPDUMP_BASIC_AUTH_USER, PROFILING_HEAPDUMP_BASIC_AUTH_PASSWORD\n`)
  }

  passport.use(new BasicStrategy((user, password, done) => {
    if (user === BASIC_AUTH_USER && password === BASIC_AUTH_PASSWORD) {
      return done(null, true)
    }
    return done(null, false)
  }))

  app.use(passport.initialize())
  app.use('/debug', passport.authenticate('basic', { session: false }), router)
}

function initNoAuth(app, router) {
  app.use('/debug', router)
}

function doHeapdump(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  if (heapdumpInProgress) {
    resp.status(500).json({
      completed: false,
      error: 'Ignoring, heapdump in-progress',
      node: `${os.hostname}:${PORT}`,
    })
    return
  }
  heapdumpInProgress = true

  startHeapDump(err => {
    if (err) {
      resp.status(500).json({
        completed: false,
        error: err.message,
        node: `${os.hostname}:${PORT}`,
      })
      heapdumpInProgress = false
    } else {
      resp.json({
        completed: true,
        filename: heapdumpFilename,
        node: `${os.hostname}:${PORT}`,
      })
      heapdumpInProgress = false
    }
  })
}

// v8-profiler lib seg faulted and crashed on node v9.x, using heapdump lib
function startHeapDump(cb) {
  const ts = new Date().toISOString()
  //extension must be .heapsnapshot for chrome node.js developer tools
  heapdumpFilename = `heapdump-${os.hostname()}-${ts}.heapsnapshot`
  process.stdout.write(`Starting heapdump to file ${heapdumpFilename} on ${os.hostname()}:${PORT}, ${err.message}\n`)

  heapdump.writeSnapshot(heapdumpFilename, err => {
    if (err) {
      process.stdout.write(`Heapdump error on ${os.hostname()}:${PORT}, ${err.message}\n`)
    } else {
      process.stdout.write(`Completed heapdump to file ${heapdumpFilename} on ${os.hostname()}:${PORT}\n`)
    }
    if (cb) {
      cb(err, heapdumpFilename)
    }
  })
}

function setSamplingRate(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  if (profilingInProgress) {
    resp.status(409).json({
      error: 'Ignoring, profiling in-progress',
      node: `${os.hostname}:${PORT}`,
    })
    return
  }

  const newProfileSampleRateUs = req.params.rate || 1000
  profileSampleRateUs = newProfileSampleRateUs

  resp.json({
    newProfileSampleRateUs,
    node: `${os.hostname}:${PORT}`,
  })
}

function startProfilingReq(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  if (profilingInProgress) {
    resp.status(409).json({
      started: false,
      error: 'Ignoring, profiling in-progress',
      node: `${os.hostname}:${PORT}`,
    })
    return
  }

  let stopAfterSec = profilingDurationSec
  if (req.query.stopAfterSec != null) {
    try {
      stopAfterSec = parseInt(req.query.stopAfterSec || profilingDurationSec, 10)
      if (stopAfterSec < 1 || stopAfterSec > 3600) {
        throw new Error('stopAfterSec must be between 0 and 3601')
      }
    } catch (err) {
      resp.status(400).json({
        started: false,
        error: err.message,
        node: `${os.hostname}:${PORT}`,
      })
      return
    }
  }

  let sampleRateUs = profileSampleRateUs
  if (req.query.sampleRateUs != null) {
    try {
      sampleRateUs = parseInt(req.query.sampleRateUs || profileSampleRateUs, 10)
      if (sampleRateUs < 1) {
        throw new Error('sampleRateUs must be > 0')
      }
    } catch (err) {
      resp.status(400).json({
        started: false,
        error: err.message,
        node: `${os.hostname}:${PORT}`,
      })
      return
    }
  }

  const profileName = startProfiling(sampleRateUs)

  if (profileName == null) {
    resp.status(409).json({
      started: false,
      error: 'Ignoring, profiling in-progress',
      node: `${os.hostname}:${PORT}`,
    })
  } else {
    setTimeout(stopProfiling, (stopAfterSec * 1000))
    resp.status(202).json({
      started: true,
      sampleRateUs,
      filename: profileName,
      node: `${os.hostname}:${PORT}`,
      completes: new Date(Date.now() + (stopAfterSec * 1000)).toISOString(),
    })
  }
}

function startProfiling(sampleRateUs) {
  if (profilingInProgress) {
    process.stdout.write(`Ignoring, profiling in-progress on ${os.hostname()}:${PORT}\n`)
    return undefined
  }
  profilingInProgress = true

  profiler.setSamplingInterval(sampleRateUs)
  profileStartTs = new Date().toISOString()
  profileFilename = `profile-${os.hostname()}-${profileStartTs}.cpuprofile`
  profiler.startProfiling(profileFilename, true)
  process.stdout.write(`Started profiling at ${sampleRateUs} us to file ${profileFilename} on ${os.hostname()}:${PORT}\n`)
  return profileFilename
}

function stopProfilingReq(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  if (!profilingInProgress) {
    resp.status(412).json({
      stopped: false,
      error: 'Ignoring, profiling NOT in-progress',
      node: `${os.hostname}:${PORT}`,
    })
    return
  }

  stopProfiling(err => {
    if (err) {
      resp.status(500).json({
        stopped: false,
        error: err.message,
        node: `${os.hostname}:${PORT}`,
      })
    } else {
      resp.json({
        stopped: true,
        filename: profileFilename,
        node: `${os.hostname}:${PORT}`,
      })
      process.stdout.write(`Successfully stopped profiling to file ${profileFilename} on ${os.hostname()}:${PORT}\n`)
    }
  })
}

function stopProfiling(completedCB) {
  if (!profilingInProgress) {
    process.stdout.write(`Ignoring, profiling NOT in-progress on ${os.hostname()}:${PORT}\n`)
    return
  }

  const profile = profiler.stopProfiling()
  profile
    .export()
    .pipe(fs.createWriteStream(profileFilename))
    .on('finish', () => {
      profile.delete()
      profilingInProgress = false
      if (completedCB) {
        completedCB()
      } else {
        process.stdout.write(`Profiling completed to file ${profileFilename} on ${os.hostname()}:${PORT}\n`)
      }
    })
    .on('error', err => {
      profilingInProgress = false
      if (completedCB) {
        completedCB(err)
      } else {
        process.stdout.write(`Error occurred on ${os.hostname()}:${PORT}, profiling: ${err}\n`)
      }
    })
}

//rest list *.heapsnapshot, *.cpuprofile
function listFiles(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  //TODO list all profile and heapdump files

  const list = {
    node: `${os.hostname}:${PORT}`,
    profiles: [],
    heapdumps: [],
  }
}

function deleteFiles(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  const response = {
    node: `${os.hostname}:${PORT}`,
    profile: '' //TODO filename
  }
}

function targzFiles(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  //TODO
}

function downloadFile(req, resp) {
  if (incorrectHost(req, resp)) {
    return
  }

  //TODO
}

//TODO move to middleware
//if server name and/or port are passed as query params, will only succeed if hostname and/or port matches - aides in retrying till LB routes to correct node.js instance
function incorrectHost(req, resp) {
  if (req.query.host != null && req.query.host != os.hostname && req.query.host != `${os.hostname()}:${PORT}`) {
    resp.status(412).json({
      error: `Ignoring, incorrect host: ${os.hostname()}:${PORT}, try again`,
      expected: req.query.host
    })
    return true
  }
  return false
}

//default is SIGUSR1 or USR1
process.on(PROFILING_SIGNAL, () => {
  if (profilingInProgress) {
    process.stdout.write(`Ignoring, profiling in-progress on ${os.hostname()}:${PORT}\n`)
    return
  }
  startProfiling(profileSampleRateUs)
  setTimeout(stopProfiling, (profilingDurationSec * 1000))
})

// listens in heapdump lib for SIGUSR2 o USR2, this just logs it
process.on(HEAPDUMP_SIGNAL, () => {
  if (heapdumpInProgress) {
    process.stdout.write(`Ignoring, heapdump in-progress on ${os.hostname()}:${PORT}\n`)
    return
  }
  heapdumpInProgress = true
  startHeapDump(err => {
    heapdumpInProgress = false
  })
})

module.exports = {
  startService
}

//TODO call from client / test to start service
startService()
