const crypto = require('crypto')
const fetch = require('node-fetch')
const fp = require('fastify-plugin')
const jwt = require('jsonwebtoken')
const MobileDetect = require('mobile-detect')
const schema = require('./schema')
const {
  BadRequest,
  Forbidden,
  Gone,
  TooManyRequests,
  NotFound
} = require('http-errors')
const {
  differenceInDays,
  differenceInMinutes,
  format,
  isAfter,
  differenceInSeconds
} = require('date-fns')
const {
  metricsInsert,
  metricsInsertValue,
  updateAverageAgeMetric
} = require('../metrics/query')
const {
  exposureInsert,
  exposureSelect,
  minimumSelect,
  registerUpdate,
  tokenInsert,
  tokenUpdate,
  verificationDelete,
  verificationSelect
} = require('./query')

async function exposures(server, options, done) {
  const hash = (value) => {
    const sha512 = crypto.createHash('sha512')
    const data = sha512.update(value, 'utf8')

    return data.digest('hex')
  }

  const trackOTCUsage = async (createDate) => {
    await server.pg.write.query(
      metricsInsert({
        event: `OTC_VALID`,
        os: '',
        version: '',
        timeZone: options.timeZone
      })
    )
    await server.pg.write.query(
      metricsInsertValue({
        event: `OTC_TOTAL_AGE`,
        os: '',
        version: '',
        timeZone: options.timeZone,
        value: differenceInSeconds(new Date(), createDate)
      })
    )
    await server.pg.write.query(updateAverageAgeMetric())
  }

  const exchangeCodeForToken = async (id, code) => {
    const { rowCount: registerRateLimit } = await server.pg.write.query(
      registerUpdate({
        rateLimit: options.security.verifyRateLimit,
        id
      })
    )

    if (registerRateLimit === 0) {
      throw new TooManyRequests()
    }

    const { rows: hashRows } = await server.pg.read.query(
      verificationSelect({
        code
      })
    )

    if (hashRows.length === 0) {
      await server.pg.write.query(
        metricsInsert({
          event: 'OTC_INVALID',
          os: '',
          version: '',
          timeZone: options.timeZone
        })
      )
      throw new Forbidden()
    }

    const [
      {
        verificationId,
        lastUpdatedAt,
        onsetDate,
        testType,
        sendCount,
        longCode,
        createdAt
      }
    ] = hashRows

    let codeLifetime = options.security.codeLifetime
    let codeCompareDate = new Date(lastUpdatedAt)
    let eventPost = ''
    if (code === longCode && options.security.allowDeeplinks) {
      codeLifetime = options.security.codeLifetimeDeeplink
      codeCompareDate = new Date(createdAt)
      eventPost = '_LONG'
    }

    if (differenceInMinutes(new Date(), codeCompareDate) > codeLifetime) {
      await server.pg.write.query(
        metricsInsert({
          event: `OTC_EXPIRED${eventPost}`,
          os: '',
          version: '',
          timeZone: options.timeZone
        })
      )
      throw new Gone()
    }

    await server.pg.write.query(verificationDelete({ verificationId }))

    const { rows } = await server.pg.write.query(
      tokenInsert({ id, onsetDate, testType })
    )
    const [{ id: token }] = rows

    await server.pg.write.query(
      metricsInsert({
        event: `OTC_VALID${eventPost}_${sendCount}`,
        os: '',
        version: '',
        timeZone: options.timeZone
      })
    )
    await trackOTCUsage(codeCompareDate)

    return { onsetDate, testType, token }
  }

  const proxyRequest = async (response, path, body, chaffRequestHeader) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': options.verifyProxy.apiKey
    }
    if (chaffRequestHeader) {
      headers['X-Chaff'] = chaffRequestHeader
    }
    const result = await fetch(`${options.verifyProxy.url}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    response.status(result.status)

    return result.json() 
  }

  const chaffRequest = (headers) => {
    return headers && 'x-chaff' in headers
  }

  const logChaff = async (eventName) => {
    await server.pg.write.query(
      metricsInsert({
        event: `CHAFF_${eventName}`,
        os: '',
        version: '',
        timeZone: options.timeZone
      })
    )
  }

  const randomString = (minLen, maxLen) => {
    return crypto
      .randomBytes(Math.random() * (maxLen - minLen) + minLen)
      .toString('base64')
  }

  /**
   * Allows users to validate the verification code they get when given a positive diagnosis. The request contains a
   * 256 character hash made up of two 128 character hashes. The first 128 characters contain a control code while the
   * second 128 character hash contains the actual verification code given to the user.
   *
   * See schema.js/verify for details oon the input/output structure.
   *
   * First, we verify the user is within configured rate limits (same user can't verify more than 1 code per second,
   * regardless of the code value).
   *
   * Next, we verify that the control code is within configured rate limits (the first
   * 3 digits of the code cannot be verified more than once per second). This means that codes 123456 and 123987
   * cannot be verified within the same second, regardless of the user verifying either. This check exists to help
   * limit attacks if someone is registering new user records to bypass user rate limit checks. I don't know how
   * effective such a check will end up being, and it does add a database write. The result of this database call
   * is again checked against rate limiting, but I'm not quite sure why the double check is done - perhaps to
   * protect against slow database connections?
   *
   * Next, we delete the verification record, using both the control and full code to delete only a single record.
   * This call returns when the code record was created and the user's onset date (I assume onset of symptoms). The
   * code TTL is verified to be within the configured lifetime, using .env value `CODE_LIFETIME_MINS`. On dev this
   * is set to CODE_LIFETIME_MINS=10.
   *
   * And finally, the user's ID and onset date is inserted into the upload_tokens table. This call results in the
   * generation of a new upload_token ID value, which is returned to the caller.
   *
   * Responses:
   *  200: Upload token, if everything is successful
   *  403: If the code doesn't exist, or it does exist but the last verification attempt on it was within the
   *    configured rate limit period.
   *  410: If the code is too old
   *  429: If any rate limit checks fail
   */
  server.route({
    method: 'POST',
    url: '/exposures/verify',
    schema: schema.verify,
    handler: async (request) => {
      const { id } = request.authenticate()

      if (chaffRequest(request.headers)) {
        await logChaff('VERIFY')
        return {
          token: crypto.randomBytes(16).toString('hex'),
          padding: randomString(512, 1024)
        }
      }
      const { hash } = request.body

      const codeHash = hash.substr(128)

      const { token } = await exchangeCodeForToken(id, codeHash)

      return { token, padding: randomString(512, 1024) }
    }
  })

  server.route({
    method: 'GET',
    url: '/v',
    handler: async (request, response) => {
      const { c: code } = request.query
      const md = new MobileDetect(request.headers['user-agent'])
      const os = md.os()

      if (!options.security.allowDeeplinks) {
        throw new NotFound('Not found')
      }
      response.status(301)
      if (os === 'iOS') {
        response.header('Location', options.deeplinks.appstoreLink)
        return `<a href="${options.deeplinks.appstoreLink}">Install App</a>.`
      } else if (os === 'AndroidOS') {
        const playstoreLink = `https://play.google.com/store/apps/details?id=${options.deeplinks.packageName}`
        const redirectLink = `intent://v?c=${code}&r=${
          options.exposures.defaultRegion
        }#Intent;scheme=ens;package=${
          options.deeplinks.packageName
        };action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(
          playstoreLink
        )};end`

        response.status(303)
        response.header('Location', redirectLink)
        return `<a href="${encodeURI(redirectLink)}">See Other</a>.`
      } else {
        response.header('Location', options.deeplinks.defaultWebPage)
        return `<a href="${options.deeplinks.defaultWebPage}">Install App</a>.`
      }
    }
  })

  server.route({
    method: 'POST',
    url: '/verify',
    schema: schema.exchange,
    handler: async (request, response) => {
      const { id } = request.authenticate()
      const { code } = request.body

      if (options.verifyProxy.url !== '') {
        if (chaffRequest(request.headers)) {
          await logChaff('VERIFY')
        }
        const result = await proxyRequest(
          response,
          '/api/verify',
          { code },
          request.headers['x-chaff']
        )

        if (!result.error) {
          await server.pg.write.query(
            metricsInsert({
              event: code.length === 16 ? 'OTC_VALID_LONG' : 'OTC_VALID',
              os: '',
              version: '',
              timeZone: options.timeZone
            })
          )
        } else {
          let event =
            result.errorCode === 'code_expired' ? 'OTC_EXPIRED' : 'OTC_INVALID'
          if (code.length === 16) {
            event += '_LONG'
          }
          await server.pg.write.query(
            metricsInsert({
              event,
              os: '',
              version: '',
              timeZone: options.timeZone
            })
          )
        }

        return result
      } else {
        if (chaffRequest(request.headers)) {
          await logChaff('VERIFY')
          return {
            testtype: 'confirmed',
            token: randomString(300, 350),
            padding: randomString(512, 1024)
          }
        }
        const codeHash = hash(code)

        const { onsetDate, testType, token } = await exchangeCodeForToken(
          id,
          codeHash
        )

        if (!onsetDate) {
          throw new Forbidden()
        }

        const symptomDate = format(onsetDate, 'yyyy-MM-dd')

        return {
          error: '',
          symptomDate,
          testtype: testType,
          token: jwt.sign({}, options.verify.privateKey, {
            algorithm: 'ES256',
            audience: options.security.jwtIssuer,
            expiresIn: options.security.refreshTokenExpiry,
            issuer: options.security.jwtIssuer,
            jwtid: token,
            keyid: String(options.verify.keyId),
            subject: `${testType}.${symptomDate}`
          }),
          padding: randomString(100, 400)
        }
      }
    }
  })

  server.route({
    method: 'POST',
    url: '/certificate',
    schema: schema.certificate,
    handler: async (request, response) => {
      const { id } = request.authenticate()
      const { ekeyhmac, token } = request.body

      if (options.verifyProxy.url !== '') {
        if (chaffRequest(request.headers)) {
          await logChaff('CERT')
        }

        const result = await proxyRequest(
          response,
          '/api/certificate',
          {
            ekeyhmac,
            token
          },
          request.headers['x-chaff']
        )

        if (!result.error) {
          await server.pg.write.query(
            metricsInsert({
              event: 'UPLOAD_CERTIFIED',
              os: '',
              version: '',
              timeZone: options.timeZone
            })
          )
        }

        return result
      } else {
        if (chaffRequest(request.headers)) {
          await logChaff('CERT')
          return {
            certificate: randomString(300, 350),
            padding: randomString(512, 1024)
          }
        }

        const { jti } = jwt.verify(token, options.verify.publicKey, {
          audience: options.security.jwtIssuer,
          issuer: options.security.jwtIssuer
        })

        const { rowCount, rows } = await server.pg.write.query(
          tokenUpdate({ id, token: jti })
        )

        if (rowCount === 0) {
          throw new Forbidden()
        }

        const [{ onsetDate, testType }] = rows

        if (!onsetDate) {
          throw new Forbidden()
        }

        await server.pg.write.query(
          metricsInsert({
            event: 'UPLOAD_CERTIFIED',
            os: '',
            version: '',
            timeZone: options.timeZone
          })
        )

        return {
          certificate: jwt.sign(
            {
              reportType: testType,
              symptomOnsetInterval: Math.floor(
                onsetDate.getTime() / 1000 / 600
              ),
              trisk: [],
              tekmac: ekeyhmac
            },
            options.verify.privateKey,
            {
              algorithm: 'ES256',
              audience: options.exposures.certificateAudience,
              expiresIn: '15m',
              issuer: options.security.jwtIssuer,
              keyid: String(options.verify.keyId)
            }
          ),
          error: '',
          padding: randomString(512, 1024)
        }
      }
    }
  })

  const uploadHandler = async (request) => {
    const { id } = request.authenticate()
    const padding = randomString(512, 1024)

    if (chaffRequest(request.headers)) {
      await logChaff('PUBLISH')
      return {
        insertedExposures: 0,
        error: '',
        padding
      }
    } else {
      const { deviceVerification } = options
      const { exposures, platform, regions, temporaryExposureKeys, token } =
        request.body

      const resolvedPlatform = platform || ''
      const resolvedRegions = regions || [options.exposures.defaultRegion]

      const resolvedExposures = (exposures || temporaryExposureKeys).map(
        ({
          key,
          keyData,
          rollingPeriod,
          rollingStartNumber,
          transmissionRisk,
          transmissionRiskLevel
        }) => {
          const resolvedKey = key || keyData
          const resolvedRollingPeriod = rollingPeriod || 144
          const resolvedTransmissionRisk =
            transmissionRisk || transmissionRiskLevel

          return {
            key: resolvedKey,
            rollingPeriod: resolvedRollingPeriod,
            rollingStartNumber,
            transmissionRiskLevel: resolvedTransmissionRisk
          }
        }
      )

      let resolvedOnsetDate = null
      let resolvedTestType = 'confirmed'

      if (token) {
        await request.verify(token.replace(/-/g, ''))

        const { rows } = await server.pg.write.query(tokenUpdate({ id, token }))

        if (rows.length === 0) {
          throw new Forbidden()
        }

        const [{ createdAt, onsetDate }] = rows

        if (
          differenceInMinutes(new Date(), new Date(createdAt)) >
          options.exposures.tokenLifetime
        ) {
          throw new Gone()
        }

        resolvedOnsetDate = onsetDate
      } else {
        const { appPackageName, hmackey, verificationPayload } = request.body

        const { reportType, symptomOnsetInterval, tekmac } = jwt.verify(
          verificationPayload,
          options.verify.publicKey,
          {
            audience: options.security.jwtIssuer,
            issuer: options.security.jwtIssuer
          }
        )

        // TODO: apply necessary transformations and remove this log
        request.log.info({ tekmac }, 'expected nonce')
        await request.verify(tekmac)

        const exposuresString = resolvedExposures
          .sort((a, b) => a.key.localeCompare(b.key))
          .map(
            ({
              key,
              rollingStartNumber,
              rollingPeriod,
              transmissionRiskLevel
            }) =>
              `${key}.${rollingStartNumber}.${rollingPeriod}.${transmissionRiskLevel}`
          )
          .join(',')

        const secret = Buffer.from(hmackey, 'base64')
        const hash = crypto
          .createHmac('sha256', secret)
          .update(exposuresString)
          .digest('base64')

        if (
          deviceVerification.apkPackageName &&
          appPackageName !== deviceVerification.apkPackageName
        ) {
          throw new Forbidden('Invalid package name')
        }

        if (hash !== tekmac) {
          throw new Forbidden('Keys do not match HMAC')
        }

        resolvedOnsetDate = new Date(symptomOnsetInterval * 100 * 600)
        resolvedTestType = reportType
      }

      if (exposures.length > options.exposures.maxKeys) {
        throw new BadRequest('Too many keys')
      }

      const filteredExposures = resolvedExposures.filter(
        ({ key, rollingStartNumber, rollingPeriod }) => {
          const startTime = rollingStartNumber * 1000 * 600
          const duration = rollingPeriod * 1000 * 600
          const decodedKey = Buffer.from(key, 'base64')

          if (isAfter(new Date(startTime), new Date())) {
            throw new BadRequest('Future keys are not accepted')
          }

          if (decodedKey.length !== 16) {
            throw new BadRequest('Invalid key length')
          }

          return (
            resolvedOnsetDate === null ||
            isAfter(new Date(startTime + duration), new Date(resolvedOnsetDate))
          )
        }
      )

      if (filteredExposures.length > 0) {
        await server.pg.write.query(
          exposureInsert({
            exposures: filteredExposures.map((exposure) => {
              const startDate = new Date(
                exposure.rollingStartNumber * 1000 * 600
              )
              const daysSinceOnset = resolvedOnsetDate
                ? differenceInDays(startDate, resolvedOnsetDate)
                : 0

              return {
                ...exposure,
                daysSinceOnset
              }
            }),
            regions: resolvedRegions,
            testType: resolvedTestType
          })
        )
      }

      await server.pg.write.query(
        metricsInsert({
          event: 'UPLOAD',
          os: resolvedPlatform,
          version: '',
          timeZone: options.timeZone
        })
      )

      return {
        insertedExposures: filteredExposures.length,
        error: '',
        padding
      }
    }
  }

  /**
   * Allows users who've tested positive to submit their Temporary Exposure Keys (TEK) for later distribution.
   *
   * First, we verify the provided token, which I believe is the upload_token ID value.
   * TODO: Get clarification on the call to request.verify with the token
   *
   * Next, the upload_token record is deleted from the upload_tokens table. This means that user can only
   * use an upload_token once. Subsequent uploads are not supported at this time.
   * TODO: This is an APHL issue
   *
   * We then verify that the upload token has been used within its configured lifetime, set via .env variable
   * `UPLOAD_TOKEN_LIFETIME_MINS`, which on dev is set to `UPLOAD_TOKEN_LIFETIME_MINS=1440` (24 hours).
   *
   * We then filter out any TEKs whose lifetime ended before the saved onset date. This ensures that we only
   * public TEKs that were active during or after the user's onset date.
   *
   * And finally we write the TEKs to the database.
   *
   * Responses:
   *  204: Everything was accepted
   *  403: Upload token doesn't exist
   *  410: Upload token is too old
   */
  server.route({
    method: 'POST',
    url: '/exposures',
    schema: schema.upload,
    handler: async (request, response) => {
      await uploadHandler(request)

      response.status(204)
    }
  })

  server.route({
    method: 'POST',
    url: '/publish',
    schema: schema.publish,
    handler: uploadHandler
  })

  /**
   * Allows users to request a list of all the exposure files that have been generated since they last
   * requested exposure files. The caller includes `since` which is the largest exposure file ID they've
   * seen. Exposure file IDs are sequentially generated by the database, and always count up. So if the
   * user has seen files 1,2,3,4,5 then they'll pass `since = 5` and this will return a list of files
   * with ID > 5.
   *
   * OUTDATED: The user can also include a `limit` value to indicate the number of files they want to receive in
   * the response. If they include `limit=2` then, using the above example, they SHOULD receive a response
   * with files 6 and 7, even if files 8, 9, and 10 exist. They can then make additional requests for
   * files since 7. Rinse and repeat until they have all the files. (NOTE, there is a bug, documented
   * below, causing the user to perhaps not receive all files since they last requested them)
   *
   * CURRENT: The exposure file generation has been modified to generate files such that any particular user
   * only needs to download a single file, regardless of days they may have missed. For example, if today is
   * day 4, and the user has downloaded files 1, 2, and 3 then the user will get a link to a file containing
   * TEKs for day 4. But if the user has downloaded files for days 1 and 2 then the user will get a link to
   * a file containing TEKs for days 3 and 4. And if the user has downloaded files for day 1 only then the
   * user will get a link to a file containing TEKs for days 2, 3, and 4. The file generation process generates
   * all of these options and this endpoint figures out the most appropriate file for the user.
   *
   * Due to this change the `limit` parameter is no longer utilized because users should only get a single
   * file link anyway.
   *
   * The user can also include a list of regions to filter by.
   *
   * Responses:
   *  200: List of files with exposure keys. The list contains the file ID and path. See schema.js/list
   *   for details on the structure.
   */
  server.route({
    method: 'GET',
    url: '/exposures',
    schema: schema.list,
    handler: async (request) => {
      request.authenticate()

      const { since, region, limit, os, version } = request.query
      const files = []
      const resolvedLimit = Math.max(limit || 0, 6)
      const resolvedRegion = region || options.exposures.defaultRegion

      let more = true
      let next = since || 0

      while (more) {
        const { rowCount, rows } = await server.pg.read.query(
          exposureSelect({
            region: resolvedRegion,
            since: next
          })
        )

        if (rowCount) {
          const [{ id, path }] = rows

          files.push({ id, path })
          next = id
        }

        if (!rowCount || resolvedLimit <= files.length) {
          more = false
        }
      }

      if (since > 0) {
        const { rowCount, rows } = await server.pg.read.query(
          minimumSelect({
            region: resolvedRegion
          })
        )

        if (rowCount > 0) {
          const [{ earliest }] = rows

          if (since < earliest) {
            server.log.info({ earliest, since }, 'old file requested')

            await server.pg.write.query(
              metricsInsert({
                event: 'EXPOSURE_FILES_REQUEST_OLD',
                os: os || '',
                version: version || '',
                timeZone: options.timeZone
              })
            )
          }
        }
      }

      await server.pg.write.query(
        metricsInsert({
          event: 'EXPOSURE_FILES_REQUEST',
          os: os || '',
          version: version || '',
          timeZone: options.timeZone
        })
      )

      return files
    }
  })

  done()
}

module.exports = fp(exposures)
