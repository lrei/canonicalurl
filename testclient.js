var fs = require('fs')
var request = require('request')

var COUNTER = 0
var COUNTERFAIL = 0
var COUNTERCONNECT = 0
var listPath = '/tmp/urlist5.txt'

function loadList (path) {
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

function elapsedMilliSecondsSince (start) {
  var end = process.hrtime() // get the current time

  // calculate elased seconds and convert to nanoseconds
  var ns = Math.abs(end[0] - start[0]) * 1e9

  // calculate total elapsed nanoseconds
  ns = ns + Math.abs(end[1] - start[1])

  return ns / 1e6 // convert to milliseconds
}

// GO
var urlist = loadList(listPath)
console.log('URLs in list: ' + urlist.length)
var start = process.hrtime() // get the current time
urlist.forEach((u, index, array) => {
  var qs = { url: u }
  var server = 'http://127.0.0.1:7171/'

  var nodeOut = (5 * 60 + 1) * 1000 // timeout + 1 sec
  request({url: server, qs: qs, timeout: nodeOut}, (err, res, b) => {
    if (err) { // No valid GET reply
      COUNTERFAIL = COUNTERFAIL + 1
      if (err.connect === true) {
        // this error occurs if the socket can't connect to the server
        COUNTERCONNECT = COUNTERCONNECT + 1
      }
    } else {
      COUNTER = COUNTER + 1
    }
    if (COUNTER + COUNTERFAIL === urlist.length) {
      console.log('Used URL list: ' + listPath)
      console.log('Timeout parameter: ' + nodeOut)
      console.log('Sucess: ' + COUNTER)
      console.log('Failure: ' + COUNTERFAIL)
      console.log('Connection: ' + COUNTERCONNECT)
      console.log(elapsedMilliSecondsSince(start))
    }
  })
})
console.log('requests made in ' + elapsedMilliSecondsSince(start))
