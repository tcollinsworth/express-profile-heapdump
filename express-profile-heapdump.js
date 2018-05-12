const express = require('express')

const heapdump = require('heapdump')
const profile = require('v8-profiler')

const fs = require('fs')
const os = require('os')

const ENABLE = (process.env.PROFILING_HEAPDUMP_ENABLED || 'false').toLowerCase() === 'true'

const BASIC_AUTH_USER = process.env.PROFILING_HEAPDUMP_BASIC_AUTH_USER || 'change' //change:me base64 encoded = Y2hhbmdlOm1l
const BASIC_AUTH_PASSWORD = process.env.PROFILING_HEAPDUMP_BASIC_AUTH_PASSWORD || 'me'

const HOST = process.env.PROFILING_HEAPDUMP_HOST || 'localhost'
const PORT = process.env.PROFILING_HEAPDUMP_PORT || '6660'

const PROFILING_DURATION_MS_DEFAULT = parseInt(process.env.PROFILING_DURATION_MS_DEFAULT || '300000', 10) // 5 min

//http://man7.org/linux/man-pages/man7/signal.7.html
const PROFILING_SIGNAL = process.env.PROFILING_SIGNAL || 'SIGUSR1' // SIGUSR1 = 30,10,16
const HEAPDUMP_SIGNAL = process.env.HEAPDUMP_SIGNAL || 'SIGUSR2' // SIGUSR2 = 31,12,17

const router = express.Router()
//export router for adding to existing express service
//client is responsible for protecting, authenticating/authorizing access
exports.default = router

let serviceStarted = false
let profilingDurationMs = PROFILING_DURATION_MS_DEFAULT

let profilingInProgress = false
let heapdumpInProgress = false

//using only GET so it works via browser URL and one less argument via curl
router.get('/heapdump', doHeapdump)

router.get('/profile/rate/:rate', setSamplingRate)
router.get('/profile/start', startProfilingReq)
router.get('/profile/stop', stopProfiling)

router.get('/list', listFiles) //TODO only specific files, no paths
router.get('/targz', targzFiles) //TODO all, or specified, only specific files, no paths
router.get('/download/:filename', downloadFile) //TODO only specific files, no paths
router.get('/delete', deleteFiles) //TODO only specific files, no paths

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

// Default basic auth initialization, can be replace
function initBasicAuth(app, router) {
  const passport = require('passport')
  const BasicStrategy = require('passport-http').BasicStrategy

  if (BASIC_AUTH_USER === 'change' && BASIC_AUTH_PASSWORD === 'me') {
    process.stdout.write(`WARNING: change the following express-profile-heapdump environment vars in production on ${os.hostname()}:${PORT}: PROFILING_HEAPDUMP_BASIC_AUTH_USER, PROFILING_HEAPDUMP_BASIC_AUTH_PASSWORD\n`)
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

//rest list *.heapsnapshot, *.cpuprofile
//rest delete xxx.heapsnapshot or xxx.cpuprofile
//curl download with compression *.heapsnapshot, *.cpuprofile

//REST
//always returns server hostname and port
//if server name and/or port are passed as query params, will only succeed if hostname and/or port matches - aides in retrying till LB routes to correct node.js instance

// set sampling rate
// /profile/start
// /profile/stop
// /heapdump

// SIGUSR1
// SIGUSR2

function doHeapdump(req, resp) {
  if (heapdumpInProgress) {
    process.stdout.write(`Ignoring, heapdump currently in-progress on ${os.hostname()}:${PORT}\n`)
    return
  }
  heapdumpInProgress = true
  //TODO
  const response = {
    node: `${os.hostname}:${PORT}`,
    heapdump: '' //TODO filename
  }
}

function setSamplingRate(req, resp) {
  if (profilingInProgress) {
    process.stdout.write(`Ignoring, profiling currently in-progress for ${profilingDurationMs} ms on ${os.hostname()}:${PORT}\n`)
    return
  }
  //TODO
  const response = {
    node: `${os.hostname}:${PORT}`,
  }
}

function startProfilingReq(req, resp) {

  const response = {
    node: `${os.hostname}:${PORT}`,
    profile: '' //TODO filename
  }
}

function startProfiling() {
  if (profilingInProgress) {
    process.stdout.write(`Ignoring, profiling currently in-progress for ${profilingDurationMs} ms on ${os.hostname()}:${PORT}\n`)
    return
  }
  profilingInProgress = true
  //TODO
}

function stopProfilingReq(req, resp) {
  //TODO
  const response = {
    node: `${os.hostname}:${PORT}`,
    profile: '' //TODO filename
  }
}

function stopProfiling() {
  if (!profilingInProgress) {
    process.stdout.write(`Ignoring, profiling NOT currently in-progress for ${profilingDurationMs} ms on ${os.hostname()}:${PORT}\n`)
    return
  }
  //TODO
}

function listFiles(req, resp) {
  //TODO list all profile and heapdump files
  const list = {
    node: `${os.hostname}:${PORT}`,
    profiles: [],
    heapdumps: [],
  }
}

function deleteFiles(req, resp) {
  const response = {
    node: `${os.hostname}:${PORT}`,
    profile: '' //TODO filename
  }
}

function targzFiles(req, resp) {

}

function downloadFile(req, resp) {

}

process.on(PROFILING_SIGNAL, () => {
  if (profilingInProgress) {
    process.stdout.write(`Ignoring, profiling currently in-progress for ${profilingDurationMs} ms on ${os.hostname()}:${PORT}\n`)
    return
  }
  profilingInProgress = true
  process.stdout.write(`Start profiling for ${profilingDurationMs} ms on ${os.hostname()}:${PORT}\n`)
  startProfiling()
  setTimeout(stopProfiling, profilingDurationMs)
  process.stdout.write(`Stop profiling on ${os.hostname()}:${PORT}\n`)
})

// already listens in heapdump as SIGUSR2
process.on(HEAPDUMP_SIGNAL, () => {
  process.stdout.write(`Starting heapdump on ${os.hostname()}:${PORT}\n`)
})

module.exports = {
  startService
}

//TODO call from client / test to start service
startService()
