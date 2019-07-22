import * as functions from 'firebase-functions';
import escapeHtml from 'escape-html';
import {
  Contexts,
  dialogflow, DialogflowConversation,
  Suggestions,
} from 'actions-on-google';
import {ssml} from 'actions-on-google/util/ssml'
import {ContextValues} from "actions-on-google/dist/service/dialogflow";

interface ConversationData {
  list: { offset: number; limit: number; };
  artists: string[];
}

type UserStorage = {}

type Conversation = DialogflowConversation<ConversationData, UserStorage>;


const app = dialogflow<ConversationData, UserStorage>({debug: true});

app.intent('Default Welcome Intent', conv => {
  conv.ask('Hi, do you want to play a song, artist or playlist?');
  conv.ask(new Suggestions(['song', 'artist', 'playlist']));
});

function createArtistListSsml(artistNames: string[]) {
  const firstLetter = 'A';
  return <speak>
    <p>
      <s>
        Here are the artists starting with the letter
        <say-as interpret-as="characters">{firstLetter}</say-as>:
      </s>
      {
        artistNames
          .map((artist, i) => <s>{i + 1}. {escapeHtml(artist)}</s>)
          .join('\n')
      }
    </p>
  </speak>
}

function listSsml(items: string[]) {
  return <speak>
    <p>
      {
        items
          .map((item, index) => <s>{index + 1}. {escapeHtml(item)}</s>)
          .join('\n')
      }
    </p>
  </speak>
}

function getArtistNames({artists, list: {offset, limit}}: ConversationData) {
  return artists.slice(offset, offset + limit);
}

app.intent<{ letter: string }>('Artist', conv => {
  conv.data.artists = [
    'Alan Walker',
    'Alessia Cara',
    'Alesso',
    'Alestorm',
    'Alex Skrindo',
    'Alexa Lusader',
  ];
  conv.data.list = {
    offset: 0,
    limit: 3,
  };
  conv.ask(createArtistListSsml(getArtistNames(conv.data)));
});

function extendContextLifespan<TContexts extends Contexts>(
  contexts: ContextValues<TContexts>, contextName: string) {
  const c = contexts.get(contextName);
  if (c) {
    c.lifespan++;
    contexts.set(contextName, c.lifespan, c.parameters);
  } else {
    console.debug(`Could not extend lifespan of context ${contextName}, because context is not alive`);
  }
}

function extendArtistFollowupContextLifespan<TContexts extends Contexts>(
  contexts: ContextValues<TContexts>) {
  extendContextLifespan(contexts, 'artist-followup');
}

app.intent('Artist - select.number', (conv, params: { number: string }) => {
  const artistNr = parseInt(params.number);
  const selectedArtist = conv.data.artists[artistNr - 1];
  conv.close(`You have selected artist ${artistNr}: ${escapeHtml(selectedArtist)}`);
});

function listNextArtists(conv: Conversation) {
  extendArtistFollowupContextLifespan(conv.contexts);
  conv.data.list.offset += conv.data.list.limit;
  conv.ask(listSsml(getArtistNames(conv.data)));
}

app.intent('Artist - more', listNextArtists);
app.intent('Artist - next', listNextArtists);

app.intent('Artist - previous', function listPreviousArtists(conv: Conversation) {
  extendArtistFollowupContextLifespan(conv.contexts);
  const {limit, offset} = conv.data.list;
  conv.data.list.offset = Math.max(0, offset - limit);
  conv.ask(listSsml(getArtistNames(conv.data)));
});

app.intent('Artist - repeat', function listPreviousArtists(conv: Conversation) {
  extendArtistFollowupContextLifespan(conv.contexts);
  conv.ask(listSsml(getArtistNames(conv.data)));
});

app.intent('Goodbye', conv => {
  conv.close('See you later!')
});

app.intent('Default Fallback Intent', conv => {
  conv.ask(`I didn't understand. Can you tell me something else?`)
});

exports.fulfillment = functions.https.onRequest(app);
