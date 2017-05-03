
/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// Controller.js is the central point for retrieving and sending messages to the bot. It takes the financial questions
// and makes calls to the respective Portfolio Investment and Simulated Instrument Analysis services. 

var debug = require('debug')('bot:controller');
var extend = require('extend');
var Promise = require('bluebird');
var conversation = require('./api/conversation');
var cloudant = require('./api/cloudant');
var format = require('string-template');
var pick = require('object.pick');
var mcache = require('memory-cache'); // For maintaining state of a Conversation
var twilio = require('twilio'); // Twilio integration
var numeral = require('numeral');
var util = require('util');
var rp = require('request-promise');
var fs = require('fs');
var HashMap = require('hashmap');

var portfolio_Id = 'P1'; //get this via the curl command curl -X GET -u "{service-user-id}":"{service-user_password}" --header 'Accept: application/json' '{service-url}/api/v1/portfolios'
var sendMessageToConversation = Promise.promisify(conversation.message.bind(conversation));
var getUser = Promise.promisify(cloudant.get.bind(cloudant));
var saveUser = Promise.promisify(cloudant.put.bind(cloudant));
var dbCustomers = cloudant.dbname;
var _messageResponse = {};
var _holdings = {};

// Investment Portfolio Service Credentials
var port_userId = process.env.CRED_PORTFOLIO_USERID;
var port_pwd = process.env.CRED_PORTFOLIO_PWD;

//Simulated Instrument Analytics Service Credentials
var simulated_instrument_analytics_url = process.env.CRED_SIMULATED_INSTRUMENT_ANALYTICS_URL;
var simulated_instrument_analytics_accesstoken = process.env.CRED_SIMULATED_INSTRUMENT_ANALYTICS_ACCESSTOKEN;
var simulated_instrument_analytics_scenariofile = process.env.CRED_SIMULATED_INSTRUMENT_ANALYTICS_SCENARIO_FILENAME;


var GREETING = "Hello, Welcome to the Personal Wealth Managment Portfolio Bot; Ask a question such as: How are my portfolio listing? OR What is the impact on my portfolio if the S&P 500 goes down 5% ";



/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//TEST DATA - this is what is returned from the function getRiskAnalyticsMultiRP() - use this as test data if you don't have the service instantiated
//Hardcoded data used for testing - uncomment if you want to use
/*var INPUT =
[
  [{
    instrument: 'CX_US681919BA38_USD',
    scenario: 'Base Scenario (0.0000)',
    values: [
      {
        "THEO/Value": "131.1828 USD",
        "date": "\"2017/03/10\""
      }
    ]
  }, {
    instrument: 'CX_US681919BA38_USD',
    scenario: 'CONDITIONAL_1 (1.0000)',
    values: [
      {
        "THEO/Value": "131.1718 USD",
        "date": "\"2017/03/10\""
      }
    ]
  }],
  [{
    instrument: 'CX_US03523TBF49_USD',
    scenario: 'Base Scenario (0.0000)',
    values: [
      {
        "THEO/Value": "91.1828 USD",
        "date": "\"2017/03/10\""
      }
    ]
  }, {
    instrument: 'CX_US03523TBF49_USD',
    scenario: 'CONDITIONAL_1 (1.0000)',
    values: [
      {
        "THEO/Value": "89.0000 USD",
        "date": "\"2017/03/10\""
      }
    ]
  }]
] */

//Test data for Investment Portfolio Service //uncomment if you don't have the service instantiated and primed with instrument data
var HOLDINGS_INPUT =
 [
    {"asset":"IBM","quantity":36, "instrument_Id": "CX_US681919BA38_USD"},{"asset":"LNVGY","quantity":520, "instrument_Id":"CX_US03523TBF49_USD" }
 ]

// END OF TEST DATA
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


// Return a promise for calling the IBM Portfolio service
// Input param: Id of an existing portfolio
function getPortfolioHoldingsRP(portfolioId) {

  // JTE TODO is there a better way to dynamically construct RESTful path?
  var sURI = util.format("%s/%s/holdings", process.env.URL_GET_PORTFOLIO_HOLDINGS, portfolioId);
  var options = {
   uri: sURI,
   auth: {
     'user': port_userId,
     'pass': port_pwd
   },
   json: true // Automatically parses the JSON string in the response
  };
  return rp(options);
}

function getHoldingsFromResponse(getHoldingsResp) {
  if( getHoldingsResp.holdings.length > 0 ) {
    return getHoldingsResp.holdings[0].holdings;
  }
  else {
    return [];
  }
}

// Returns the construction of the call to the IBM Simulated Analytics Service - one instrument at a time 
// Input: id of a single instrument
function getRiskAnalyticsRP(instrument) {

  // Construct full RESTful URL
  var fullURL = simulated_instrument_analytics_url + "/" + instrument;

  // Create request-promise POST request w/headers
  var req = rp.post({url:fullURL, json: true,

    headers: {
      'X-IBM-Access-Token': simulated_instrument_analytics_accesstoken,
      'EncType': 'multipart/form-data'
    }});

  // Populate the Form w/requested analytics and scenario_file
  var form = req.form();
  //form.append('analytics', RISK_ANALYTICS_REQUESTED_ANALYTICS);
  //form.append('scenario_file', fs.createReadStream(simulated_instrument_analytics_scenariofile));
  form.append('scenario_file', fs.createReadStream("/Users/laurabennett/2017-NewRole/Code/new-teck-chatbot/resources/conditional_out.csv"));
  //console.log("req ", req);*/
  return req; 
}

// Returns a promise to get the values of any number of analytics for a given set of instruments.
// Input: Instruments to analyse
function getRiskAnalyticsMultiRP(instruments) {

  // UNCOMMENT THIS WHEN CODE WORKS
  // Generate promises for invoking risk analytics API on each instrument in array
  var rpPromises = [];
    for (var i = 0; i < instruments.length; i++) {
    var rpPromise = getRiskAnalyticsRP(instruments[i]);
    rpPromises.push(rpPromise);
  } 

  // Wait on all promises to complete
  return Promise.all(rpPromises);
}

// Parse the results of the instrument analytics and compute the % change
// Input: Results of promise
function parseRiskAnalyticsResults(raResults) {

  var response = [];  // return value

  var BASE_SCENARIO_NAME_PREFIX = 'Base';
  var THEO_SCENARIO_NAME_PREFIX = 'CONDITIONAL';
  var ANALYTICS_NAME = 'THEO/Price';
  var iaPair = [];
  var insName = "";
  var insBaseValue = 0;
  var insTheoValue = 0;
  //var analysis = {};

  var response = [];  // return value


  // For-each pair of base/theoretical analyses for an instrument
  for (var i = 0; i < raResults.length; i++) {

    // Instrument scenario analyses pair
    iaPair = raResults[i];
    insName = iaPair[0].instrument; // get instrument name from first analysis
    insBaseValue = insTheoValue = 0;

    // For each scenario analysis (should only be 2)
    for (var j = 0; j < iaPair.length; j++) {
      var analysis = iaPair[j];

      // Handle base
      if( analysis.scenario.startsWith(BASE_SCENARIO_NAME_PREFIX)) {
        // Truncate trailing USD
        tmp = analysis.values[0][ANALYTICS_NAME];
        insBaseValue = tmp.split(' ')[0];
      }
      else if(analysis.scenario.startsWith(THEO_SCENARIO_NAME_PREFIX)) {
        // Truncate trailing USD
        var tmp = analysis.values[0][ANALYTICS_NAME];
        insTheoValue = tmp.split(' ')[0];
      }
      else {
        // Don't know how to handle this type of scenario
        console.console.error("Invalid scenario", analysis.scenario, "skipping" );
        continue;  // <----------- continue --------------!
      }
    }

    //console.log("!!!", insName, insBaseValue, insTheoValue);
    
    // Very basic error-checking
    if( insBaseValue==0 || insTheoValue==0) {
      // Something went wrong with this instrument
      console.console.error("Instrument does not have values for base and conditional scenarios, skipping it" );
    }
    else {
      // Compute percent change
      var pcChange = (insTheoValue-insBaseValue)/insBaseValue;
      response.push( {'id':insName, 'baseValue':insBaseValue, 'theoValue':insTheoValue, 'pcChange':pcChange});
    }
  }

  return response;
}


// Compute $ impact of a risk analysis on a portfolio
// Input: Portfolio Instruments & the analytics
function portfolioRAImpact( portfolio, riskAnalytics ) {

  //console.log(">>>>>riskAnalytics", riskAnalytics);
  
  // Create map on risk analytics response (instrumentId => analysis)
  var mapRA = riskAnalytics.reduce(function(map,analytic) {
    map.set(analytic.id, analytic);
    return map;
  }, new HashMap());

  
  // Get the inner array of holdings from GetPorfolio response
  var holdings = getHoldingsFromResponse(portfolio);
  
  // Compute the overall change in portfolio value as well as
  // impact to each holding
  var totalValueChange = 0.0;
  var totalBaseValue = 0.0;
  var holdingsImpacts = [];

  holdings = HOLDINGS_INPUT; //REMOVE THIS WHEN DATA FILE IS CORRECT
  
  for (var i = 0; i < holdings.length; i++) {


    var holding = holdings[i];
    var pcChange = 0;
    var valueChange = 0.0;
    var instrumentId = holding.instrument_Id;
    var assetName = holding.asset;
    var quantity = holding.quantity;

    // Compute change in position value if an analytic was computed for it
    if( mapRA.has(instrumentId) ) {
      var anal = mapRA.get(instrumentId);
      pcChange = anal.pcChange;
      valueChange = (anal.theoValue - anal.baseValue) * quantity;
      totalValueChange += valueChange;
      totalBaseValue += anal.baseValue * quantity;
    }

    holdingsImpacts.push( {'asset':assetName, 'quantity':quantity, 'pcChange':pcChange, 'valueChange':valueChange } );
  }

  // Compute the portion of value impact of each holding to the total
  for (var i = 0; i < holdingsImpacts.length; i++) {
    // JTE TODO handle Div0 (e.g. if no portfolio impact)
    holdingsImpacts[i].portfolioImpactPC = holdingsImpacts[i].valueChange / totalValueChange;
  }

  //console.log('totalBaseValue',totalBaseValue);
  var portfolioImpact = { 'totalValueChange':totalValueChange, 'totalPCChange':totalValueChange/totalBaseValue, 'impactByHolding':holdingsImpacts};
  //console.log('portfolioImpact ', portfolioImpact);
  return portfolioImpact;
}


module.exports = {
  /**
   * Process messages from a channel and send a response to the user
   * @param  {Object}   message.user  The user
   * @param  {Object}   message.input The user meesage
   * @param  {Object}   message.context The conversation context
   * @param  {Function} callback The callback
   * @return {void}dbuser*/
  processMessage: function(_message, res, callback) {
    var message = extend({ input: {text: _message.Body} }, _message);
    //var input = message.text ? { text: message.text } : message.input;
    var user = message.user || message.from;
    //res.json(JSON.stringify(message)); //tried to see if i could write to res
    //res.send(JSON.stringify(message));

    //var phoneNum = "+1 (732) 759-9154";  //phone number
    //var phoneNum = message.user || message.from;  //phone number HARDCODING DURING TESTING
    //phoneNum = phoneNum.replace(/\D/g,''); // strip all non-numeric chars
    //console.log('message: ' + JSON.stringify(message));
    

    debug('1. Process new message: %s.', JSON.stringify(message.input, null, 2));

    //console.log('-----------------');
    //console.log('/SMS Input received: ' + JSON.stringify(message.input, null, 2) + ' from ' + phoneNum );


    getUser(user).then(function(dbUser) {
      var context = dbUser ? dbUser.context : {};
      message.context = context;
      
      // dummy code for the chaining 
      return getUser(user).then(function(dbUser) { 
      })
      .then(function() {
          debug('2. Send message to Conversation.', JSON.stringify(message, null, 2));
          return sendMessageToConversation(message);
      })


      //3. Process the response from Conversation
      .then(function(messageResponse) {
          debug('3. Conversation response: %s.', JSON.stringify(messageResponse, null, 2));
         
          // Extract response returned by Watson
          var responseContext = messageResponse.context;
          var firstIntent = (messageResponse.intents != null && messageResponse.intents.length>0 ) ? messageResponse.intents[0] : null;
          var intentName = (firstIntent != null) ? firstIntent.intent : "";
          var intentConfidence = (firstIntent != null) ? firstIntent.confidence : "";

          var firstEntity = (messageResponse.entities != null && messageResponse.entities.length>0 ) ? messageResponse.entities[0] : null;
          var entityName = (firstEntity != null) ? firstEntity.entity : "";
          var entityValue= (firstEntity != null) ? firstEntity.value : "";

          var conversationId = messageResponse.context.conversation_id;
          console.log('Detected intent {' + intentName + '} with confidence ' + intentConfidence);
          console.log('Detected entity {' + entityName + '} with value {' + entityValue + "}");
          console.log('Conversation id = ' + conversationId);
          console.log('Conversation context = ' + JSON.stringify(messageResponse.context));
          _messageResponse = extend({}, messageResponse);
          return _messageResponse.intents.map(function(x) {return x.intent; });
        })
        .then (function (intentName) {
          debug('4. identify intent');
          if ( intentName == "hello") {
             _messageResponse.output.text = GREETING;
             return _messageResponse;
          } 
          else
          { 
            return getPortfolioHoldingsRP(portfolio_Id);
          }
        }) 
        .then (function (options) {
          debug('5. Parse holdings');
          var intent = _messageResponse.intents.map(function(x) {return x.intent; });
          var holdings = {};
          if (intent == 'hello')
             return _messageResponse;
          else
          {   //Get the Investment Portfolio Holdings
              holdings = getHoldingsFromResponse(options);
              _holdings = options;
              console.log('Portfolio', portfolio_Id, 'raw holdings are:', holdings);
              // Check whether no holdings
              if(holdings == null || holdings.length < 1) {
                //sendTwilioResponse('Your portfolio is empty', res);
                console.log('Your portfolio is empty');
                _messageResponse.output.text = 'Your portfolio is empty';  
              }
              else if( intent == "portfolio_holdings")
              {
                 debug('6. Intent is portfolio holdings');
                 var strPositions = holdings.reduce(function(arr,holding) {
                 arr.push( util.format(" %s shares of %s", holding.quantity, holding.asset));
                    return arr;
                 }, []).join();
                 var holdingsMsg = "Your portfolio consists of" + strPositions;

                 _messageResponse.output.text = holdingsMsg;
                 return _messageResponse;
              }
              else
              {
                 debug('7. Intent is portfolio impact analysis');
                // Extract Instrument Id's into array

                 //TEMP CODE  -  Hardcoded the instruments codes DELETE NEXT 3 LINES ONCE DATA FILE IS UPDATED and uncomment the following 2 lines
                 var instrument_array = ['CX_US4592001014_NYQ', 'CX_US3696041033_NYQ'];
                 var aInstrumentIds = instrument_array.reduce(function(arr,instrument_array) {
                    arr.push(instrument_array);
                    //var aInstrumentIds = holdings.reduce(function(arr,holding) {  //uncomment once you get data inserted into portfolio holdings via postman
                    //arr.push(holding.instrumentId); //uncomment when data file is working
                    return arr;
                  }, []);

                  
                  return(getRiskAnalyticsMultiRP(aInstrumentIds));
              }
            } //end of else for get the investment portfolio holdings
          }) //end of then for Parse Holdings
              .then( function(riskAnalyticsResponse) {
                var intent = _messageResponse.intents.map(function(x) {return x.intent; });
                if (intent == 'hello') return _messageResponse;
                else if (intent =='portfolio_holdings') return _messageResponse;
                else //intent is portfolio impact
                {
                    var analyticsForInstrumentsResponse = parseRiskAnalyticsResults(riskAnalyticsResponse);
                    //var portImpactResponse = portfolioRAImpact(getHoldingsResp, analyticsForInstrumentsResponse); // use when data is set up
                    var portImpactResponse = portfolioRAImpact(_holdings, analyticsForInstrumentsResponse);

                    //console.log("portImpactResponse", portImpactResponse);
                }

                    // Analyze results and form response message
                    var msg;
                    if( portImpactResponse.totalValueChange == 0) {
                      msg = 'Under that scenario your portfolio could be unaffected';
                    } else
                    {
                      msg = util.format('Under that scenario your portfolio could %s by %s%, or %s',
                                  (portImpactResponse.totalValueChange<0)?'decrease':'increase',
                                  numeral(Math.abs(portImpactResponse.totalPCChange)*100.0).format('0,00.00'),
                                  numeral(portImpactResponse.totalValueChange).format('$0,0')
                                );
                    }

                    _messageResponse.output.text = msg;
                    return _messageResponse;
              })
                     
      .then(function(messageToUser) {
         debug('8. Save conversation context.and send message response to bot');
         if (!dbUser) {
           dbUser = {_id: user};
         }
         dbUser.context = messageToUser.context;
         return saveUser(dbUser)
         .then(function(data) {
            debug('9. Send response to the user.');
            messageToUser = extend(messageToUser, _message);
            callback(null, messageToUser);
         });
      })
    })
      .catch(function (error) {
        debug(error);
        callback(error);
      });
  }
}