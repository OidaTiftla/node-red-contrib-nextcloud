module.exports = function (RED) {
  const dav = require('dav')
  const webdav = require('webdav')
  const fs = require('fs')
  const IcalExpander = require('ical-expander')
  const moment = require('moment')
  const https = require('https')

  function getErrorMessage (err) {
    if (!err) {
      return 'Unknown error'
    }
    return err.message || JSON.stringify(err)
  }

  function getServerConfig (node, msg, protocol) {
    if (!node.server) {
      node.error(`Nextcloud:${protocol} -> missing server configuration.`, msg)
      return null
    }

    if (!node.server.address || !node.server.credentials || !node.server.credentials.user || !node.server.credentials.pass) {
      node.error(`Nextcloud:${protocol} -> incomplete server credentials.`, msg)
      return null
    }

    return {
      address: node.server.address,
      user: node.server.credentials.user,
      pass: node.server.credentials.pass
    }
  }

  function getHttpsOptions (server) {
    const options = {}
    if (server.insecure) {
      options.agent = new https.Agent({ rejectUnauthorized: false })
    }
    return options
  }

  function NextcloudConfigNode (config) {
    RED.nodes.createNode(this, config)
    this.address = config.address
    this.insecure = config.insecure
  }
  RED.nodes.registerType('nextcloud-credentials', NextcloudConfigNode, {
    credentials: {
      user: { type: 'text' },
      pass: { type: 'password' }
    }
  })

  function NextcloudCalDav (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.calendar = config.calendar
    this.pastWeeks = config.pastWeeks || 0
    this.futureWeeks = config.futureWeeks || 4
    const node = this

    node.on('input', (msg) => {
      const server = getServerConfig(node, msg, 'CalDAV')
      if (!server) {
        return
      }

      let startDate = moment().startOf('day').subtract(this.pastWeeks, 'weeks')
      let endDate = moment().endOf('day').add(this.futureWeeks, 'weeks')
      const filters = [{
        type: 'comp-filter',
        attrs: { name: 'VCALENDAR' },
        children: [{
          type: 'comp-filter',
          attrs: { name: 'VEVENT' },
          children: [{
            type: 'time-range',
            attrs: {
              start: startDate.format('YYYYMMDD[T]HHmmss[Z]'),
              end: endDate.format('YYYYMMDD[T]HHmmss[Z]')
            }
          }]
        }]
      }]
      // dav.debug.enabled = true;
      const xhr = new dav.transport.Basic(
        new dav.Credentials({
          username: server.user,
          password: server.pass
        })
      )
      // Server + Basepath
      let calDavUri = server.address + '/remote.php/dav/calendars/'
      // User
      calDavUri += server.user + '/'
      dav.createAccount({ server: calDavUri, xhr: xhr, loadCollections: true, loadObjects: true })
        .then(function (account) {
          if (!account.calendars) {
            node.error('Nextcloud:CalDAV -> no calendars found.', msg)
            return
          }
          // account instanceof dav.Account
          account.calendars.forEach(function (calendar) {
            // Wenn Kalender gesetzt ist, dann nur diesen abrufen
            let calName = msg.calendar || node.calendar
            if (!calName || !calName.length || (calName && calName.length && calName === calendar.displayName)) {
              dav.listCalendarObjects(calendar, { xhr: xhr, filters: filters })
                .then(function (calendarEntries) {
                  let msg = { 'payload': { 'name': calendar.displayName, 'data': [] } }
                  calendarEntries.forEach(function (calendarEntry) {
                    try {
                      const ics = calendarEntry.calendarData
                      const icalExpander = new IcalExpander({ ics, maxIterations: 100 })
                      const events = icalExpander.between(startDate.toDate(), endDate.toDate())
                      msg.payload.data = msg.payload.data.concat(convertEvents(events))
                    } catch (error) {
                      node.error('Error parsing calendar data: ' + error, msg)
                    }
                  })
                  node.send(msg)
                }, function (err) {
                  node.error(`Nextcloud:CalDAV -> get ics went wrong: ${getErrorMessage(err)}`, msg)
                })
            }
          })
        }, function (err) {
          node.error(`Nextcloud:CalDAV -> get calendars went wrong: ${getErrorMessage(err)}`, msg)
        })
    })

    function convertEvents (events) {
      const mappedEvents = events.events.map(_convertEvent)
      const mappedOccurrences = events.occurrences.map(_convertEvent)
      return [].concat(mappedEvents, mappedOccurrences)
    }

    function _convertEvent (e) {
      if (e) {
        let startDate = e.startDate.toString()
        let endDate = e.endDate.toString()

        if (e.item) {
          e = e.item
        }
        if (e.duration.wrappedJSObject) {
          delete e.duration.wrappedJSObject
        }

        return {
          startDate: startDate,
          endDate: endDate,
          summary: e.summary || '',
          description: e.description || '',
          attendees: e.attendees,
          duration: e.duration.toICALString(),
          durationSeconds: e.duration.toSeconds(),
          location: e.location || '',
          organizer: e.organizer || '',
          uid: e.uid || '',
          isRecurring: false,
          allDay: ((e.duration.toSeconds() % 86400) === 0)
        }
      }
    }
  }
  RED.nodes.registerType('nextcloud-caldav', NextcloudCalDav)

  function NextcloudCardDav (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.addressBook = config.addressBook
    const node = this

    node.on('input', (msg) => {
      const server = getServerConfig(node, msg, 'CardDAV')
      if (!server) {
        return
      }

      const xhr = new dav.transport.Basic(
        new dav.Credentials({
          username: server.user,
          password: server.pass
        })
      )

      // Server + Basepath
      let cardDavUri = server.address + '/remote.php/dav/addressbooks/users/'
      // User
      cardDavUri += server.user + '/'
      // ToDo Filter ?
      dav.createAccount({ server: cardDavUri, xhr: xhr, accountType: 'carddav' })
        .then(function (account) {
          if (!account.addressBooks) {
            node.error('Nextcloud:CardDAV -> no addressbooks found.', msg)
            return
          }
          // account instanceof dav.Account
          account.addressBooks.forEach(function (addressBook) {
            // Wenn Adressbuch gesetzt ist, dann nur diesen abrufen
            let c = msg.addressBook || node.addressBook
            if (!c || !c.length || (c && c.length && c === addressBook.displayName)) {
              dav.listVCards(addressBook, { xhr: xhr })
                .then(function (addressBookEntries) {
                  let vcfList = { 'payload': { 'name': addressBook.displayName, 'data': [] } }
                  addressBookEntries.forEach(function (addressBookEntry) {
                    const keyValue = addressBookEntry.addressData.split('\n')
                    let vcfJson = {}
                    for (let x = 0; x < keyValue.length; x++) {
                      const separator = keyValue[x].indexOf(':')
                      if (separator === -1) {
                        continue
                      }
                      const key = keyValue[x].substring(0, separator)
                      const value = keyValue[x].substring(separator + 1)
                      vcfJson[key] = value
                    }
                    vcfList.payload.data.push(vcfJson)
                  })
                  node.send(vcfList)
                }, function (err) {
                  node.error(`Nextcloud:CardDAV -> get cards went wrong: ${getErrorMessage(err)}`, msg)
                })
            }
          })
        }, function (err) {
          node.error(`Nextcloud:CardDAV -> get addressBooks went wrong: ${getErrorMessage(err)}`, msg)
        })
    })
  }
  RED.nodes.registerType('nextcloud-carddav', NextcloudCardDav)

  function NextcloudWebDavList (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.directory = config.directory
    const node = this

    node.on('input', (msg) => {
      const server = getServerConfig(node, msg, 'WebDAV')
      if (!server) {
        return
      }

      const webDavUri = server.address + '/remote.php/webdav/'
      const client = webdav(webDavUri, server.user, server.pass)
      let directory = ''
      if (msg.directory) {
        directory = '/' + msg.directory
      } else if (node.directory && node.directory.length) {
        directory = '/' + node.directory
      }
      directory = directory.replace(/\/{2,}/g, '/')

      // check option for self signed certs
      const option = getHttpsOptions(node.server)
      client.getDirectoryContents(directory, option)
        .then(function (contents) {
          node.send({ payload: contents })
        }, function (error) {
          node.error(`Nextcloud:WebDAV -> get directory content went wrong: ${getErrorMessage(error)}`, msg)
        })
    })
  }
  RED.nodes.registerType('nextcloud-webdav-list', NextcloudWebDavList)

  function NextcloudWebDavOut (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.filename = config.filename
    const node = this

    node.on('input', (msg) => {
      const server = getServerConfig(node, msg, 'WebDAV')
      if (!server) {
        return
      }

      const webDavUri = server.address + '/remote.php/webdav/'
      const client = webdav(webDavUri, server.user, server.pass)
      let filename = ''
      if (msg.filename) {
        filename = '/' + msg.filename
      } else if (node.filename && node.filename.length) {
        filename = '/' + node.filename
      } else {
        node.error('Nextcloud:WebDAV -> no filename specified.', msg)
        return
      }
      filename = filename.replace(/\/{2,}/g, '/')

      // check option for self signed certs
      const option = getHttpsOptions(node.server)
      client.getFileContents(filename, option)
        .then(function (contents) {
          node.send({ payload: contents })
        }, function (error) {
          node.error(`Nextcloud:WebDAV -> get file went wrong: ${getErrorMessage(error)}`, msg)
        })
    })
  }
  RED.nodes.registerType('nextcloud-webdav-out', NextcloudWebDavOut)

  function NextcloudWebDavIn (config) {
    RED.nodes.createNode(this, config)
    this.server = RED.nodes.getNode(config.server)
    this.directory = config.directory
    this.filename = config.filename
    const node = this

    node.on('input', (msg) => {
      const server = getServerConfig(node, msg, 'WebDAV')
      if (!server) {
        return
      }

      // Read upload file
      let filename = node.filename
      if (msg.filename) {
        filename = msg.filename
      }
      if (!filename) {
        node.error('Nextcloud:WebDAV -> no local filename specified.', msg)
        return
      }

      const name = filename.substr((filename.lastIndexOf('/') + 1), filename.length)
      let file
      try {
        file = fs.readFileSync(filename)
      } catch (err) {
        node.error(`Nextcloud:WebDAV -> unable to read local file: ${getErrorMessage(err)}`, msg)
        return
      }

      // Set upload directory
      let directory = '/'
      if (msg.directory) {
        directory += msg.directory + '/'
      } else if (node.directory && node.directory.length) {
        directory += node.directory + '/'
      }
      directory = directory.replace(/\/{2,}/g, '/')

      const webDavUri = server.address + '/remote.php/webdav/'
      const client = webdav(webDavUri, server.user, server.pass)

      // check option for self signed certs
      const option = getHttpsOptions(node.server)

      client.putFileContents(directory + name, file, { format: 'binary' }, option)
        .then(async function (response) {
          if (!response || !response.ok) {
            const status = response ? response.status : 'unknown'
            const statusText = response ? response.statusText : 'No response'
            return node.error(`Nextcloud:WebDAV -> send file failed. Status: ${status} ${statusText}`, msg)
          }

          let payload = { status: response.status, statusText: response.statusText, size: 0, timeout: 0 }

          const text = await response.text()
          if (text) {
            try {
              const parsed = JSON.parse(text)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = { ...payload, ...parsed }
              }
            } catch (e) {
              return node.error(`Nextcloud:WebDAV -> send file response is not valid JSON: ${e.message}`, msg)
            }
          }

          payload.size = Number.isFinite(Number(payload.size)) ? Number(payload.size) : 0
          payload.timeout = Number.isFinite(Number(payload.timeout)) ? Number(payload.timeout) : 0

          node.send({ payload })
        }, function (err) {
          node.error(`Nextcloud:WebDAV -> send file went wrong: ${err.message}`, msg)
        })
    })
  }
  RED.nodes.registerType('nextcloud-webdav-in', NextcloudWebDavIn)
}
