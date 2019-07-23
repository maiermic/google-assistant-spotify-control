import SpotifyWebApi from 'spotify-web-api-node';
import * as functions from 'firebase-functions';
import escapeHtml from 'escape-html';
import {
  Contexts,
  dialogflow, DialogflowConversation,
  Suggestions,
} from 'actions-on-google';
import {ContextValues} from "actions-on-google/dist/service/dialogflow";
import {ssml} from './ssml'

interface AfterOptions {
  after?: string
  limit?: number
}


interface Artist {
  name: string
  uri: string
}

interface ConversationData {
  list: { offset: number; limit: number; };
  artists: Artist[];
}

type UserStorage = {}

interface Conversation extends DialogflowConversation<ConversationData, UserStorage, Contexts> {
  spotify: SpotifyWebApi
}


const app = dialogflow<Conversation>({debug: true});

// @ts-ignore https://github.com/actions-on-google/actions-on-google-nodejs/issues/260
app.middleware((conv: Conversation) => {
  const config = functions.config();
  conv.spotify = new SpotifyWebApi({
    clientId: config.spotify.client.id,
    clientSecret: config.spotify.client.secret,
    redirectUri: config.spotify.redirect_uri,
  });
  conv.spotify.setAccessToken(conv.user.access.token as string);
});

app.intent('Default Welcome Intent', conv => {
  conv.ask('Hi, do you want to play a song, artist or playlist?');
  conv.ask(new Suggestions(['song', 'artist', 'playlist']));
});

function createArtistListSsml(artistNames: string[]) {
  return <speak>
    <p>
      <s>Here are your followed artists:</s>
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
  return artists.slice(offset, offset + limit).map(a => a.name);
}

async function getFollowedArtists(spotify: SpotifyWebApi): Promise<Artist[]> {
  const result: Artist[] = [];
  const options: AfterOptions = {limit: 50};
  while (true) {
    const {
      body: {
        artists: {cursors, items, next}
      }
    } = await spotify.getFollowedArtists(options);
    options.after = cursors.after;
    for (const {name, uri} of items) {
      result.push({name, uri});
    }
    if (!next) {
      break;
    }
  }
  return result;
}

function compareName(l: { name: string }, r: { name: string }) {
  return l.name.localeCompare(r.name);
}


app.intent<{ firstLetter: string }>('Artist', async (conv, {firstLetter}) => {
  const artists = await getFollowedArtists(conv.spotify);
  artists.sort(compareName);
  conv.data.artists = artists;
  conv.data.list = {
    offset: 0,
    limit: 3,
  };
  if (firstLetter) {
    const i = artists.findIndex(a => a.name.charAt(0) === firstLetter);
    if (i < 0) {
      // TODO invalid format (SSML is appended to this text afterwards)
      conv.ask(`You do not follow any artist whose name begins with ${firstLetter}. `);
    } else {
      conv.data.list.offset = i;
    }
  }
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

app.intent('Artist - select.number', async (conv, params: { number: string }) => {
  // TODO validate
  const artistNr = parseInt(params.number);
  const selectedArtist = conv.data.artists[conv.data.list.offset + artistNr - 1];
  // TODO handle error
  await conv.spotify.play({context_uri: selectedArtist.uri});
  conv.close(`You have selected artist ${artistNr}: ${selectedArtist.name}`);
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
