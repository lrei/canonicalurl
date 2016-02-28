/**
 * @file canonicalurl.js
 * @copyright Luis Rei, Josef Stefan Institute, 2016
 * @author Luis Rei me@luisrei.com @lmrei
 * @license MIT
 *
 * See https://www.github.com/lrei/canonicalurl
 * Unshortens and extracts canonical URLs (or OpenGraph URLs)
 */

const fs = require('fs')
const os = require('os')
const cluster = require('cluster')
const http = require('http')
const url = require('url')
var validUrl = require('valid-url')
var request = require('request')
var tld = require('tldjs')
var cheerio = require('cheerio')
var nconf = require('nconf')
var winston = require('winston')
var winstonCluster = require('winston-cluster')
var commander = require('commander')

/** */
var LISTENERS = []
/** maximum content size for a GET request */
var MAXSIZE = 2 * 1024 * 1024
/** timeout for a GET or HEAD request */
var TIMEOUT = 20 * 1000
/** maximum redirects to follow */
var MAXREDIRECTS = 4
/** list of domains for which HEAD and GET are allowed */
var WHITELIST = null
/** list of domain for which HEAD is allowed */
var SHORTLIST = null
/** the user agent */
var UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; ' +
  '+http://www.google.com/bot.html)'

/**
 * Returns the (absolute) time elapsed since start
 * @param {[number]} start the return of a `process.hrtime()`
 * @return {number} the elapsed time in milliseconds
 */
function elapsedMilliSecondsSince (start) {
  var end = process.hrtime() // get the current time

  // calculate elased seconds and convert to nanoseconds
  var ns = Math.abs(end[0] - start[0]) * 1e9

  // calculate total elapsed nanoseconds
  ns = ns + Math.abs(end[1] - start[1])

  return ns / 1e6 // convert to milliseconds
}

/**
 * Replies to the client request
 * @param {object} data the response JSON object
 * @param {object} res the http response related to the client request
 */
function reply (data, res) {
  // calculate elpsed time
  data.elapsed = elapsedMilliSecondsSince(data.elapsed)

  // we always use 200, we also always use JSON data
  res.writeHead(200, { 'Content-Type': 'application/json' })

  // send the data to the client
  res.write(JSON.stringify(data))

  // end the HTTP connection
  res.end()

  // log the response we sent to the client
  winston.verbose('repsonse', data)
}

/**
 * Checks a given domain list for a given domain only replies true if the list
 * exists and the domain is in it.
 * @param {string} domain the domain to check for in the list
 * @param {[string]} list the domain list
 * @return {boolean} true  if domain list exists and the domain is in it
 */
function checkDomainList (domain, list) {
  var inList = false

  if (list !== null) { // list exists
    if (list.indexOf(domain) >= 0) { // domain is int it
      inList = true
    }
  }

  return inList
}

/**
 * Checks both domain lists (SHORTLIST/WHITELIST) for a domain d
 * @param {string} d the domain name to check
 * @return {boolean} true if domain in lists or lists do not exists
 */
function checkDomainLists (d) {
  var defaultInList = true

  // check if there are loaded domain lists
  if (SHORTLIST) {
    defaultInList = false
  } else if (WHITELIST) {
    defaultInList = false
  }

  var inList = defaultInList
  if (!defaultInList) { // check if domain is in one of the lists
    inList = checkDomainList(d, SHORTLIST) || checkDomainList(d, WHITELIST)
  }

  return inList
}

/**
 * GET the content of a URL and try to extract the canonocial meta url or the
 * open graph url property
 * @param {string} url the url to fetch
 * @param {object} data an object containing the data we'll send as reply
 * @param {object} reqres the http response related to the client request
 */
function fetchContent (u, data, reqres) {
  // set up cookie jar
  var j = request.jar()
  var r = request.defaults({jar: j})

  data.get_attempt = true

  r({
    url: u,
    timeout: TIMEOUT,
    headers: {
      'user-agent': UA
    },
    gzip: true,
    maxRedirects: MAXREDIRECTS,
    followAllRedirects: true,
    time: true
  }, (err, res, b) => {
    if (err) { // No valid GET reply
      // err.code === ETIMEDOUT => timeout
      data.reason = err
      data.error = true
      reply(data, reqres)
      return
    }

    // Here we got a valid reply with a body
    // parse the html
    var parsedHtml = cheerio.load(b)
    // i'm not sure if cheerio.load always returns a non-null object
    if (parsedHtml === null) {
      data.reason = 'html parsing failed'
      data.error = true
      reply(data, reqres)
      return
    }

    data.error = false

    /**
     * Handle GET redirect
     * Might be possible that we got redirected again (not sure)
     */
    var currentUrl = res.request.uri.href
    if (currentUrl) {
      if (currentUrl !== data.url_retrieved) { // yes we got redirected
        data.url_retrieved = currentUrl
        data.tld_retrieved = tld.getDomain(currentUrl).toLowerCase().trim()
        data.method = 'redirect'
        var inList = true
        if (WHITELIST) {
          inList = checkDomainList(data.tld_retrieved, WHITELIST)
        }
        if (!inList) { // final domain not in whitelist
          reply(data, reqres)
          return
        }
      }
    }

    /**
     * try to extract a canonical or OG url from the html body
     */
    // search for a canonical link tag
    var canon_url = parsedHtml('link[rel="canonical"]').attr('href')
    if (canon_url) {
      data.url_retrieved = canon_url
      data.reason = 'canonical'
      data.method = 'canonical'
      data.canonical = true
      reply(data, reqres)
      winston.debug('got canonical: ' + canon_url)
      return
    }

    // search for an OpenGraph url property
    var og_url = parsedHtml('meta[property="og:url"]').attr('content')
    if (og_url) {
      data.url_retrieved = og_url
      data.reason = 'opengraph'
      data.method = 'opengraph'
      data.canonical = true
      reply(data, reqres)
      winston.debug('got OpenGraph: ' + og_url)
      return
    }

    // if we reached this point, we have not found a canonical or OG url
    data.reason = 'no canonical'
    reply(data, reqres)
    winston.debug('no canonical/og')
  })
}

/**
 * Make HEAD Request and handle response
 * @param {string} url the URL to follow
 * @param {boolean} get attempt to fetch HTML and extract canonical after HEAD
 * @param {object} data the data for the eventual reply
 * @param {object} reqres the http response related to the client request
 */
function headRequest (u, get, data, reqres) {
  request({
    url: u,
    method: 'HEAD',
    headers: {
      'user-agent': UA
    },
    timeout: TIMEOUT,
    maxRedirects: MAXREDIRECTS,
    followAllRedirects: true,
    time: true
  }, (err, res, b) => {
    if (err) {
      data.reason = err
      // No valid HEAD reply
      reply(data, reqres)
      winston.log('debug', 'HEAD error', {url: u})
      return
    }
    winston.log('debug', 'HEAD reply received', {url: u})

    // Process HEAD Reply
    data.method = 'original'
    data.elapsed_head = elapsedMilliSecondsSince(data.elapsed)

    // get the status code
    data.code = res.statusCode

    // get the content type
    data.ctype = res.headers['content-type'] || null
    if (data.ctype) {
      data.ctype = data.ctype.toLowerCase()
    }

    // get content size
    data.size = res.headers['content-length'] || 0

    // get redirect url
    data.url_retrieved = res.request.uri.href
    if (!data.url_retrieved || data.url_retrieved === u) { // no (new) url
      // use previous url
      data.url_retrieved = u
      // check if url is in whitelist
      inList = checkDomainList(data.tld, WHITELIST)
    } else { // new url different from old url
      // set method (how we got this url) to redirect
      data.method = 'redirect'
      winston.log('debug', 'got redirected', data)
      // extract tld
      data.tld_retrieved = tld.getDomain(data.url_retrieved)
      // check that extracted tld is valid
      if (data.tld_retrieved) { // valid tld
        data.tld_retrieved = data.tld_retrieved.toLowerCase().trim()
        // check if url is in whitelist
        inList = checkDomainList(data.tld_retrieved, WHITELIST)
      } else { // invalid tld
        inList = false
      }
    }

    winston.log('debug', 'create service response', data)

    /** Replies
     */

    // 1. Check for bad status code
    if (data.code >= 400) {
      data.reason = 'HTTP error: ' + data.code
      reply(data, reqres)
      winston.log('debug', data.reason, data)
      return
    }

    // 2. Check for bad content type
    if (data.ctype) {
      if (data.ctype.indexOf('text/html') < 0) {
        data.reason = 'bad content type: ' + data.ctype
        reply(data, reqres)
        winston.log('debug', data.reason, data)
        return
      }
    // Fall through to the next check
    }

    // 3. Check for no content type
    if (!data.ctype) {
      data.reason = 'no content type:'
      reply(data, reqres)
      winston.log('debug', data.reason, data)
      return
    }

    // 4. Check if content size is too big
    if (data.size > MAXSIZE) {
      data.reason = 'content to big: ' + data.size
      reply(data, reqres)
      winston.log('debug', data.reason, data)
      return
    }

    // 5. Check if final tld not in whitelist
    if (!inList) {
      data.reason = 'domain not in whitelist'
      reply(data, reqres)
      winston.log('debug', data.reason, data)
      return
    }

    // 5. Check if content fetching is disabled
    if (!get) {
      data.reason = 'content fetching disabled'
      reply(data, reqres)
      winston.log('debug', data.reason, data)
      return
    }

    // go get the content
    winston.log('debug', 'go fetch', data)
    fetchContent(data.url_retrieved, data, reqres)
    return
  })
}

/**
 * Follow redirects and (optional) fetch HTML and extract Canonical URL
 * @param {string} url the URL to follow
 * @param {boolean} get attempt to fetch HTML and extract canonical after HEAD
 * @param {object} reqres the http response related to the client request
 */
function fetchCanonical (u, get, reqres) {
  var data = {
    'url': u,
    'url_retrieved': null,
    'method': null,
    'reason': null,
    'error': true,
    'get_attempt': false,
    'canonical': false,
    'elapsed': process.hrtime()
  }

  // check if url is valied
  if (!validUrl.isWebUri(u)) {
    data.reason = 'invalid url'
    data.method = 'url validation'
    reply(data, reqres)
    return
  }

  // Check domain lists
  // extract the top level domain (tld) e.g. 'bbc.co.uk' from the url
  var d = tld.getDomain(u)
  if (d) {
    d = d.toLowerCase().trim()
  }
  data.tld = d
  var inList = checkDomainLists(d)

  if (!inList || !d) { // domain not in lists, reply and return
    data.reason = 'domain not in lists'
    reply(data, reqres)
    return
  }

  headRequest(u, get, data, reqres)
}

/**
 * Load a line delimited domain list from a file
 * @param {string} path the path to the domain list file
 * @returns {[string]} a list of domain names
 */
function loadDomainList (path) {
  var list = null
  var s
  // read if exists
  if (fs.existsSync(path)) {
    s = fs.readFileSync(path, 'utf8')
  } else {
    s = null
  }
  // split lines if file loaded
  if (s !== null) {
    list = s.split('\n').map((line) => {
      return line.toLowerCase().trim() // lower case and trim items
    })
    // make unique in case there are duplicates
    list = list.filter((value, index, self) => {
      return self.indexOf(value) === index
    })
    // remove if starts with '#' (=> line is a comment)
    list = list.filter((line) => {
      if (line) {
        if (line[0] !== '#') {
          return true
        }
      }
      return false
    })
    return list
  }
  return null
}

/**
 * Loads the two domain lists into globals.
 * The file paths are specified in nconf.
 */
function loadFilterLists () {
  // get file paths
  var whitelist_path = nconf.get('whitelist')
  var shortlist_path = nconf.get('shortlist')

  // Load filter lists into globals
  WHITELIST = loadDomainList(whitelist_path)
  if (WHITELIST) {
    winston.debug('whitelist: ' + WHITELIST.length)
  } else {
    winston.warn('no whitelist')
  }

  SHORTLIST = loadDomainList(shortlist_path)
  if (WHITELIST) {
    winston.debug('shortlist: ' + SHORTLIST.length)
  } else {
    winston.warn('no shortlist')
  }
}

/**
 * @summary Starts the Master
 * Starts the Master, uses parameters in nconf.
 * 1. Setup logging
 * 2. Fork workers
 * 3. Error handling
 */
function startServerMaster () {
  // General logging setup
  var log_path = nconf.get('log')
  var logrotate = nconf.get('rotate')
  if (logrotate) {
    winston.add(winston.transports.DailyRotateFile, {
      'timestamp': true,
      'datePattern': '.yyyy-MM-dd',
      'filename': log_path
    })
  } else {
    winston.add(winston.transports.File, {
      'timestamp': true,
      'filename': log_path
    })
  }
  winston.remove(winston.transports.Console)

  // Fork workers.
  numCpus = nconf.get('numcpus') || os.cpus().length

  winston.info('Starting workers ' + numCpus)
  for (var i = 0; i < numCpus; i++) {
    cluster.fork()
  }

  // Bind logging listeners to workers
  winstonCluster.bindListeners()

  // Log when all workers are listening
  cluster.on('listening', (worker, address) => {
    var newLength = LISTENERS.push(worker.process.pid)
    winston.debug('listening: ' + worker.process.pid)
    if (newLength === numCpus) {
      winston.info('All Workers listening: ' + newLength)
    }
  })

  // Error handling: if a worker terminates unexpectedly, start a new worker
  cluster.on('exit', function (worker, code, signal) { // worker died
    winston.log('worker ' + worker.process.pid + ' died')
    LISTENERS.splice(LISTENERS.indexOf(worker.process.pid))
    // Start a new worker worker
    cluster.fork()
  })
}

/**
 * Starts a Worker
 * Uses parameters in nconf
 */
function startServerWorker () {
  // Replace default transport with cluster transport
  winstonCluster.bindTransport()

  // Setup parameters
  MAXSIZE = nconf.get('maxsize')
  TIMEOUT = nconf.get('timeout')
  MAXREDIRECTS = nconf.get('maxredirects')
  port = nconf.get('port')
  var doGet = !nconf.get('noget')
  var nrqs = 1 + doGet // 1 + true = 2, 1 + false = 1 (3> javascript)
  var tolerance = 5 // tolerance in seconds
  tolerance = tolerance * 1000 // tolerance in ms
  var serverOut = TIMEOUT * MAXREDIRECTS * nrqs + tolerance

  // Load Filter Lists
  loadFilterLists()

  // winston.debug('Listening on port ' + port)

  // Workers can share the HTTP server
  http.createServer(function (req, res) {
    var start = process.hrtime() // get the current time
    var parsedUrl = url.parse(req.url, true)
    // @TODO handle error
    var u = parsedUrl.query.url
    // try to fetch the unshortened or canonical url
    fetchCanonical(u, doGet, res)
    // request closed unexpectedly
    req.on('close', function () {
      var reqdata = {
        elaspsed: elapsedMilliSecondsSince(start),
        url: u
      }
      winston.log('warn', 'connection closed unexpectedly', reqdata)
    })
  }).listen(port).setTimeout(serverOut)
}

/**
 * @summary Starts the server
 * Starts the server cluster: master and workers
 *  1. Reads parameters from the configuration sources
 *  2. Sets up logging
 *  3. Forks the workers (startServerMaster)
 *  4. Starts listening. (startServerWorker)
 */
function startServer () {
  // Configuration
  var numCpus = os.cpus().length
  var port = 7171 // default port

  nconf.argv()
    .env({'match': /^CANONICALURL_/, 'separator': '__'})
    .file({ file: '/etc/canonicalurl/config.json' })
    .file({ file: './canonicalurl.json' })
    .defaults({
      'port': port,
      'numcpus': numCpus,
      'maxsize': MAXSIZE,
      'timeout': TIMEOUT,
      'maxredirects': MAXREDIRECTS,
      'whitelist': './whitelist.txt',
      'shortlist': './shorteners.txt',
      'log': '/tmp/canonicalurl.log',
      'loglevel': 'verbose',
      'rotate': false,
      'noget': false
    })
  winston.level = nconf.get('loglevel')

  // Set MaxListeners
  process.setMaxListeners(0)

  // Node Cluster Setup
  if (cluster.isMaster) {
    startServerMaster()
  } else {
    startServerWorker()
  }
}

/**
 * Parses command line options setting `commander` module variable parameters
 */
function cli () {
  commander
    .version('1.0.0')
    .option('--port <n>', 'Set service port <n>', parseInt)
    .option('--numcpus <n>', 'Number of parallel processes to use', parseInt)
    .option('--timeout <n>', 'Timeout for HTTP HEAD/GET (ms)', parseInt)
    .option('--maxsize <n>', 'Max content length for GET (bytes)', parseInt)
    .option('--noget', 'Unshorten with HEAD only, no GET or HTML parsing')
    .option('--shortlist <path>', 'Location of the url shorteners list')
    .option('--whitelist <path>', 'Location of the white list')
    .option('--log <path>', 'Location of the log file to use')
    .option('--loglevel <value>', 'Log level e.g. "info"')
    .option('--logrotate', 'Logs by day')
    .option('--config <path>', 'Use specified configuration file')
    .parse(process.argv)
}

// Run directly
if (require.main === module) {
  // command line interface options
  cli()

  // start the server
  startServer()
}
