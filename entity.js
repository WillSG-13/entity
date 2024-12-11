const moment = require('moment')

const { sendError, sendLog } = require('@notifications/utils/helpers')
const {
  NotificationEvent,
  NotificationMedium,
  NotificationType,
  AuthorizedApplication,
  NotificationTemplate,
  NotificationTemplateType,
  orm,
} = require('@notifications/db')
const { processLiveNotification } = require('@notifications/api-jobs')
const { saveAttachmentCDN } = require('@notifications/attachments')
const { isEmail } = require('@notifications/utils/validations')
const templates = require('@notifications/mail')
const {
  helpers: { logError },
} = require('@notifications/utils')
const { Utils } = require('@notifications/core')

async function create(req, res, next) {
  try {
    let parameters
    let medium
    let registeredBy = null
    let { notificationMediumId } = req.body
    const { templateCode, context } = req.body
    const { data, notificationMediumName, type, isLive, attachments } = req.body
    let { sendTo } = req.body

    sendLog('Se verifican las credenciales del evento de notificación')
    if (req.application) {
      parameters = {
        status: 1,
        authorizedApplication: req.application.id,
      }
    } else {
      parameters = {
        status: 1,
      }
    }

    if (notificationMediumId) {
      const dataBody = await NotificationMedium.findOne({
        where: { id: notificationMediumId },
      })

      verifyQueriedData(dataBody)
    } else if (notificationMediumName) {
      parameters.name = notificationMediumName
      medium = await NotificationMedium.findOne({
        where: parameters,
        order: [['id', 'ASC']],
        status: 1,
      })

      verifyQueriedData(medium)
      notificationMediumId = medium.id
    } else if (type) {
      const notificationType = await NotificationType.findOne({
        where: { code: type },
      })

      verifyQueriedData(notificationType)

      parameters.notificationTypeId = notificationType.id
      medium = await NotificationMedium.findOne({
        where: parameters,
        order: [['id', 'ASC']],
      })

      verifyQueriedData(medium)
      notificationMediumId = medium.id
    }

    if (!req.isAdmin) {
      registeredBy = req.application.id
      await verifiedToken(notificationMediumId, req)
    }

    if (data) {
      await verifiedData(sendTo, data, notificationMediumId)

      if (sendTo instanceof Array) {
        sendTo = sendTo.join(';')
      }

      const dataBody = await NotificationEvent.create(
        {
          sendTo,
          data,
          notificationMediumId,
          registeredBy,
          attachments: await validAttachments(attachments),
        },
        { isPartitioned: true }
      )
      if (!dataBody) {
        sendError('notificationevent:registerNotificationEvent', 404)
      }
      if (isLive) {
        await processLiveNotification(dataBody.id)
      }
      res.success({
        message: req.t('notificationevent:messageInsert'),
        data: dataBody,
      })
    } else {
      if (!templateCode || !context) {
        sendError('notificationevent:noTemplateContext', 400)
      }

      const notificationData = await createNotificationData(
        templateCode,
        context
      )

      sendLog('Se crea el evento de notificación (Se encola)')
      const dataBody = await NotificationEvent.create(
        {
          sendTo,
          data: notificationData,
          notificationMediumId,
          registeredBy,
          attachments: await validAttachments(attachments),
        },
        { isPartitioned: true }
      )

      if (!dataBody)
        sendError('notificationevent:registerNotificationEvent', 400)

      if (isLive) {
        sendLog('Se procesa la notificación en vivo')
        await processLiveNotification(dataBody.id)
      }
      res.success({
        message: req.t('notificationevent:messageInsert'),
        data: dataBody,
      })
    }
  } catch (error) {
    logError(error)
    next(error)
  }
}

function verifyQueriedData(data) {
  if (!data) sendError('notificationevent:noQueriedData', 400)
}
async function verifiedData(sendTo, data, notificationMediumId) {
  if (!sendTo) sendError('notificationevent:noSendTo', 400)
  if (!data) sendError('notificationevent:noData', 400)
  if (!notificationMediumId) sendError('notificationevent:noMediumType', 400)

  if ((await searchTypeCode(notificationMediumId)) === 'email') {
    await searchDataTypeEvent(data)

    if (!(await isEmail(sendTo)))
      sendError('notificationevent:noSendToValid', 400)
    if (!data.subject) sendError('notificationevent:noDataSubject', 400)
    if (!data.body) sendError('notificationevent:noDataBody', 400)
    if (!data.type) sendError('notificationevent:noDataType', 400)
  }
  if ((await searchTypeCode(notificationMediumId)) === 'push') {
    if (!sendTo) sendError('notificationevent:noSendToDeviceToken', 400)
    if (!data.to) sendError('notificationevent:noDataToDeviceToken', 400)
    if (!data.notification)
      sendError('notificationevent:noDataPushNotification', 400)
    if (!data.data) sendError('notificationevent:noDataPushNotification', 400)
    if (!data.notification.sound || !data.data.sound)
      sendError('notificationevent:noDataNotificationSound', 400)
    if (!data.notification.body || !data.data.body)
      sendError('notificationevent:noDataNotificationBody', 400)
    if (!data.notification.title || !data.data.title)
      sendError('notificationevent:noDataNotificationTitle', 400)
    if (!data.notification.content_available || !data.data.content_available)
      sendError('notificationevent:noDataNotificationContentAvailable', 400)
    if (!data.notification.priority || !data.data.priority)
      sendError('notificationevent:noDataNotificationPriority', 400)
    if (!data.data.payload)
      sendError('notificationevent:noDataNotificationPayload', 400)
    if (!data.data.payload.message)
      sendError('notificationevent:noDataNotificationPayloadMessage', 400)
    if (!data.data.payload.title)
      sendError('notificationevent:noDataNotificationPayloadTitle', 400)
  }
  if ((await searchTypeCode(notificationMediumId)) === 'sms') {
    if (!data.message) sendError('notificationevent:noMessage', 400)
    if (data.typeSMS === 'aws') {
      if (!data.countryCode)
        sendError('notificationevent:noDataCountryCode', 400)
    }
    if (data.typeSMS === 'ice') {
      if (!data.campaign) sendError('notificationevent:noDataCampaign', 400)
    }
  }
  if ((await searchTypeCode(notificationMediumId)) === 'push-aws') {
    if (!data.message) sendError('notificationevent:noMessage', 400)
  }
}

async function verifiedToken(notificationMediumId, req) {
  const pass = await NotificationMedium.findOne({
    where: { id: notificationMediumId },
    attributes: ['notificationTypeId'],
    include: [
      {
        model: AuthorizedApplication,
        attributes: ['token'],
      },
    ],
  })
  if (pass.AuthorizedApplication.token !== req.application.token)
    sendError('notificationevent:noTokenMatch', 400)
}

async function searchDataTypeEvent(data) {
  if (data.type === 'html') {
    if (
      data.body.charAt(0) !== '<' ||
      data.body.charAt(data.body.length - 1) !== '>'
    ) {
      sendError('notificationevent:noDataBodyHtml', 400)
    }
  } else if (data.type !== 'text') {
    sendError('notificationevent:noDataType', 400)
  }
}

async function searchTypeCode(notificationMediumId) {
  const medium = await NotificationMedium.findOne({
    where: { id: notificationMediumId },
    attributes: ['notificationTypeId'],
    include: [
      {
        model: NotificationType,
        attributes: ['code'],
      },
    ],
  })
  if (!medium) {
    sendError('notificationevent:noValidnotificationMediumId', 400)
    return false
  }
  return medium.NotificationType.code
}

async function findAll(req, res, next) {
  try {
    const response = {
      data: [],
    }

    const {
      includeAll,
      includeNested,
      sendTo,
      status,
      createdAtEventsFrom,
      createdAtEventsTo,
      sortFields,
      sortOrders,
    } = req.query

    let where = {
      ...(!req.isAdmin && { registeredBy: req.application.id }),
      ...(sendTo && { sendTo: { [orm.Op.iLike]: `%${sendTo}%` } }),
      ...(status && { status }),
    }

    let order = null
    if (sortFields && sortOrders) {
      const tempSortFields = sortFields.split(',')
      const tempSortOrders = sortOrders.split(',')

      order = tempSortFields.map((field, index) => {
        const orderArray = [field]
        orderArray.push(
          ['asc', 'desc'].includes(tempSortOrders[index].toLowerCase())
            ? tempSortOrders[index]
            : 'DESC'
        )
        return orderArray
      })
    }

    if (createdAtEventsFrom && createdAtEventsTo) {
      const startDate = moment(
        `${createdAtEventsFrom} 00:00:00`,
        'YYYY-MM-DD HH:mm:ss'
      )
      const endDate = moment(
        `${createdAtEventsTo} 23:59:59`,
        'YYYY-MM-DD HH:mm:ss'
      )

      where.createdAtEvents = {
        [orm.Op.between]: [startDate, endDate],
      }
    }

    if (includeAll === 'true') {
      delete where.registeredBy
    }

    const include = []
    if (includeNested === 'true') {
      include.push({
        model: AuthorizedApplication,
        attributes: ['id', 'name', 'code'],
      })
    }

    const { skip, limit } = await Utils.parsePaginateParameters(
      req.query.skip,
      req.query.limit
    )

    if (skip !== null) {
      const result = await NotificationEvent.findAndCountAll({
        where,
        include,
        limit: limit || 10,
        offset: skip,
        order,
      })
      response.data = result.rows
      response.paginate = await Utils.paginateParse(result.count, skip, limit)
    } else {
      response.data = await NotificationEvent.findAll({ where })
    }

    if (!response.data) {
      sendError('notificationevent:noDataFind', 400)
    }

    res.success({
      message: req.t('notificationevent:notificationEventsObtained'),
      ...response,
      data: response.data,
    })
  } catch (error) {
    logError(error)
    next(error)
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params
    const { status, data, notificationMediumId, lastError, attempts } = req.body
    let { sendTo } = req.body

    if (!id) sendError('notificationevent:noId', 400)

    const dataBody = await NotificationEvent.findOne({
      where: { id },
    })

    verifyQueriedData(dataBody)

    if (!req.isAdmin) {
      await verifiedToken(dataBody.notificationMediumId, req)
    }

    if (sendTo instanceof Array) {
      sendTo = sendTo.join(';')
    }

    sendLog('Se actualiza el evento')
    await dataBody.update({
      status,
      sendTo,
      data,
      notificationMediumId,
      lastError,
      attempts,
    })
    res.success({
      message: req.t('notificationevent:messageUpdate'),
      data: dataBody,
    })
  } catch (error) {
    logError(error)
    next(error)
  }
}

async function resend(req, res, next) {
  try {
    const { id } = req.params
    const { includeAll } = req.query

    if (!id) sendError('notificationevent:noId', 400)

    const data = await NotificationEvent.findOne({
      where: { id },
    })

    verifyQueriedData(data)

    if (!req.isAdmin && includeAll !== 'true') {
      await verifiedToken(data.notificationMediumId, req)
    }
    sendLog('Se resetea los parámetros del evento (resend)')
    await data.update({ status: 0, attempts: 0, lastError: null })

    res.success({
      message: req.t('notificationevent:messageUpdate'),
      data,
    })
  } catch (error) {
    logError(error)
    next(error)
  }
}

async function validAttachments(attachments) {
  try {
    const data = []
    if (attachments) {
      for (const attachment of attachments) {
        const body = {
          fileName: attachment.fileName,
          // eslint-disable-next-line no-await-in-loop
          data: await saveAttachmentCDN(attachment.file),
          extension: attachment.extension,
        }
        data.push(body)
      }
    }
    return data
  } catch (error) {
    sendError(error)
    return false
  }
}

async function createNotificationData(templateCode, context) {
  try {
    let response
    let emailTemplate
    const template = await NotificationTemplate.findOne({
      where: { code: templateCode },
      include: [
        {
          model: NotificationTemplateType,
          required: true,
          attributes: ['id', 'code'],
        },
      ],
    })

    if (template.NotificationTemplateType.code === 'sms') {
      template.templateData.countryCode = context.countryCode
      template.templateData.message = context.message
      template.templateData.typeSMS = context.typeSMS
      response = template.templateData
    }
    if (template.NotificationTemplateType.code === 'push') {
      template.templateData.platformArn = context.platformArn
      template.templateData.message = context.message
      template.templateData.payload = context.payload
      response = template.templateData
    }

    if (template.NotificationTemplateType.code === 'email') {
      emailTemplate = await templates.getTemplate(template.route, context)
      response = {
        subject: template.subject,
        body: emailTemplate,
        type: 'html',
      }
    }

    return response
  } catch (error) {
    sendError(error)
    return false
  }
}

module.exports = {
  create,
  findAll,
  update,
  resend,
  verifyQueriedData,
}
