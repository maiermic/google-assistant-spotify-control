import SpotifyWebApi from 'spotify-web-api-node';
import * as functions from 'firebase-functions';
import escapeHtml from 'escape-html';
import {
  Contexts,
  dialogflow, DialogflowConversation,
  Suggestions,
  Parameters,
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

interface Playlist {
  name: string
  uri: string
}

interface ConversationData {
  list: { offset: number; limit: number; };
  artists: Artist[];
}

interface UserStorage {
  responseDelay: string
}

interface Conversation extends DialogflowConversation<ConversationData, UserStorage, Contexts> {
  spotify: SpotifyWebApi
  askSsml: (sentencesOrSsml: SsmlBuilder | string | string[]) => this
  listArtistNames(): void
}

const defaultResponseDelay = '0 s';
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

// @ts-ignore https://github.com/actions-on-google/actions-on-google-nodejs/issues/260
app.middleware((conv: Conversation) => {
  // ensure configuration is set
  conv.user.storage.responseDelay = conv.user.storage.responseDelay || defaultResponseDelay;
});

// @ts-ignore https://github.com/actions-on-google/actions-on-google-nodejs/issues/260
app.middleware((conv: Conversation) => {
  conv.askSsml = (sentencesOrSsml: SsmlBuilder | string | string[]) => {
    const ssmlBuilder =
      sentencesOrSsml instanceof SsmlBuilder
        ? sentencesOrSsml
        : new SsmlBuilder(typeof sentencesOrSsml === 'string' ? [sentencesOrSsml] : sentencesOrSsml);
    return conv.ask(ssmlBuilder.build(conv.user.storage.responseDelay));
  };
  conv.listArtistNames = () => {
    const ssmlBuilder = new SsmlBuilder();
    ssmlBuilder.addList(getArtistNames(conv.data));
    conv.askSsml(ssmlBuilder);
  }
});

app.intent('Default Welcome Intent', conv => {
  conv.askSsml('Hi, do you want to play a song, artist or playlist?');
  // conv.ask('Hi, do you want to play a song, artist or playlist?');
  conv.ask(new Suggestions(['song', 'artist', 'playlist']));
});

class SsmlBuilder {
  constructor(private sentences: string[] = []) {
  }

  build(delay: string) {
    return <speak>
      <break time={delay}/>
      <prosody volume="x-loud">
        <p>{
          this.sentences
            .map(s => s.startsWith('<s>') ? s : <s>{s}</s>)
            .join('\n')
        }</p>
      </prosody>
    </speak>
  }

  add(sentence: string) {
    this.sentences.push(sentence);
  }

  addList(items: string[]) {
    const indexedItems =
      items.map((item, index) =>
        `${index + 1}. ${escapeHtml(item)}`);
    for (const i of indexedItems) {
      this.sentences.push(i);
    }
  }
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

interface ArtistIntentParameters extends Parameters {
  firstLetter: string
  spelledWord: string[]
}

interface DurationEntity {
  amount: number
  unit: string
}

interface ConfigureResponseDelayIntentParameters extends Parameters {
  delay: DurationEntity
}

app.intent<ConfigureResponseDelayIntentParameters>(
  'ConfigureResponseDelay',
  (conv, {delay}) => {
    conv.user.storage.responseDelay = `${delay.amount} ${delay.unit}`;
    conv.askSsml(`Response delay has been set to ${conv.user.storage.responseDelay}`);
  });

app.intent(
  'reset response delay',
  conv => {
    conv.user.storage.responseDelay = defaultResponseDelay;
    conv.askSsml(`Response delay has been set to ${conv.user.storage.responseDelay}`);
  });

app.intent<{count: number}>(
  'count seconds',
  (conv, {count}) => {
    const ssmlBuilder = new SsmlBuilder();
    for (let i = 0; i < count; i++) {
      ssmlBuilder.add(<s>{i}<break time="1 s"/></s>)
    }
    conv.askSsml(ssmlBuilder);
  });

app.intent<ArtistIntentParameters>(
  'Artist',
  async (conv, {firstLetter, spelledWord}: ArtistIntentParameters) => {
    const artists = await getFollowedArtists(conv.spotify);
    artists.sort(compareName);
    conv.data.artists = artists;
    conv.data.list = {
      offset: 0,
      limit: 3,
    };
    const ssmlBuilder = new SsmlBuilder();
    if (spelledWord.length) {
      const word = spelledWord.join('').toLowerCase();
      conv.data.artists = artists.filter(a => a.name.toLowerCase().includes(word));
      ssmlBuilder.add(
        <s>
          Here are your followed artists containing the word {word} spelled
          <say-as interpret-as="characters">{word}</say-as>:
        </s>);
    }
    if (firstLetter) {
      const i = artists.findIndex(a => a.name.charAt(0) === firstLetter);
      if (i < 0) {
        ssmlBuilder.add(`You do not follow any artist whose name begins with ${firstLetter}.`);
        ssmlBuilder.add(`Here are your followed artists:`);
      } else {
        conv.data.list.offset = i;
        ssmlBuilder.add(`Here are your followed artists starting with ${firstLetter}:`);
      }
    }
    ssmlBuilder.addList(getArtistNames(conv.data));
    conv.askSsml(ssmlBuilder);
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
  conv.listArtistNames();
}

app.intent('Artist - more', listNextArtists);
app.intent('Artist - next', listNextArtists);

app.intent('Artist - previous', function listPreviousArtists(conv: Conversation) {
  extendArtistFollowupContextLifespan(conv.contexts);
  const {limit, offset} = conv.data.list;
  conv.data.list.offset = Math.max(0, offset - limit);
  conv.listArtistNames();
});

app.intent('Artist - repeat', function listPreviousArtists(conv: Conversation) {
  extendArtistFollowupContextLifespan(conv.contexts);
  conv.listArtistNames();
});

async function getPlaylists(spotify: SpotifyWebApi): Promise<Playlist[]> {
  const result: Artist[] = [];
  const options = {limit: 50, offset: 0};
  while (true) {
    const {
      body: {items, next}
    } = await spotify.getUserPlaylists(options);
    options.offset += options.limit;
    for (const {name, uri} of items) {
      result.push({name: name.trim(), uri});
    }
    if (!next) {
      break;
    }
  }
  return result;
}


app.intent(
  'playlist',
  async (conv) => {
    const playlists = await getPlaylists(conv.spotify);
    playlists.sort(compareName);
    conv.data.artists = playlists;
    conv.data.list = {
      offset: 0,
      limit: 3,
    };
    const ssmlBuilder = new SsmlBuilder();
    ssmlBuilder.addList(getArtistNames(conv.data));
    conv.askSsml(ssmlBuilder);
  });

app.intent('Goodbye', conv => {
  conv.close('See you later!')
});

app.intent('Default Fallback Intent', conv => {
  conv.ask(`I didn't understand. Can you tell me something else?`)
});

exports.fulfillment = functions.https.onRequest(app);
