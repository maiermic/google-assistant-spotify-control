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


interface ListItem {
  name: string
  uri: string
}

interface ConversationData {
  list: { offset: number; limit: number; };
  items: ListItem[];
}

interface UserStorage {
  selectedListItem?: ListItem;
  responseDelay: string
}

interface Conversation extends DialogflowConversation<ConversationData, UserStorage, Contexts> {
  spotify: SpotifyWebApi
  askSsml: (sentencesOrSsml: SsmlBuilder | string | string[]) => this
  listItemNames(): void
  addListSuggestions(): void
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
  conv.listItemNames = () => {
    const ssmlBuilder = new SsmlBuilder();
    ssmlBuilder.addList(getListItemNames(conv.data));
    conv.askSsml(ssmlBuilder);
  };
  conv.addListSuggestions = () => {
    const {offset, limit} = conv.data.list;
    const total = conv.data.items.length;
    const count = Math.min(limit, total - offset);
    const suggestions: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      suggestions[i] = `${i + 1}`;
    }
    if (offset > 0) {
      suggestions.push('previous');
    }
    if (total > offset + limit) {
      suggestions.push('next');
    }
    suggestions.push('repeat');
    conv.ask(new Suggestions(suggestions));
  };
});

app.intent('Default Welcome Intent', welcome);

function welcome(conv: Conversation) {
  conv.askSsml('Hi, do you want to play a song, artist or playlist?');
  conv.ask(new Suggestions(['song', 'artist', 'playlist']));
}

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

function getListItemNames({items, list: {offset, limit}}: ConversationData) {
  return items.slice(offset, offset + limit).map(a => a.name);
}

async function getFollowedArtists(spotify: SpotifyWebApi): Promise<ListItem[]> {
  const result: ListItem[] = [];
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

interface ListIntentParameters extends Parameters {
  listItemType: 'artist' | 'playlist'
  firstLetters: string[]
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

app.intent<ListIntentParameters>(
  'list',
  async (conv, {firstLetters, spelledWord, listItemType}) => {
    const getItems: (spotify: SpotifyWebApi) => Promise<ListItem[]> = {
      artist: getFollowedArtists,
      playlist: getPlaylists,
    }[listItemType];
    const items = await getItems(conv.spotify);
    items.sort(compareName);
    conv.data.items = items;
    conv.data.list = {
      offset: 0,
      limit: 3,
    };
    const ssmlBuilder = new SsmlBuilder();
    if (spelledWord.length) {
      const word = spelledWord.join('').toLowerCase();
      conv.data.items = items.filter(a => a.name.toLowerCase().includes(word));
      ssmlBuilder.add(
        <s>
          Here are your {listItemType}s containing the word {word} spelled
          <say-as interpret-as="characters">{word}</say-as>:
        </s>);
    }
    if (firstLetters) {
      const firstWord = firstLetters.join('').toLowerCase();
      const i = items.findIndex(a => a.name.toLowerCase().startsWith(firstWord));
      if (i < 0) {
        ssmlBuilder.add(
          <s>
            None of your {listItemType}s begins with
            <say-as interpret-as="characters">{firstWord}</say-as>.
          </s>);
        ssmlBuilder.add(`Here are your ${listItemType}s:`);
      } else {
        conv.data.list.offset = i;
        ssmlBuilder.add(
          <s>
            Here are your {listItemType}s starting with
            <say-as interpret-as="characters">{firstWord}</say-as>:
          </s>);
      }
    }
    ssmlBuilder.addList(getListItemNames(conv.data));
    conv.askSsml(ssmlBuilder);
    conv.addListSuggestions();
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

function extendListFollowupContextLifespan<TContexts extends Contexts>(
  contexts: ContextValues<TContexts>) {
  extendContextLifespan(contexts, 'list-followup');
}

app.intent('list - select.number', async (conv, params: { number: string }) => {
  const {limit, offset} = conv.data.list;
  const itemNumber = parseInt(params.number);
  const ssmlBuilder = new SsmlBuilder();
  if (itemNumber < 0 || limit < itemNumber) {
    ssmlBuilder.add(`${itemNumber} is not a valid list entry.`);
    ssmlBuilder.addList(getListItemNames(conv.data));
    conv.askSsml(ssmlBuilder);
    conv.addListSuggestions();
    return;
  }
  const selectedItem = conv.data.items[offset + itemNumber - 1];
  conv.user.storage.selectedListItem = selectedItem;
  ssmlBuilder.add(`You have selected ${itemNumber}: ${selectedItem.name}.`);
  try {
    await conv.spotify.play({context_uri: selectedItem.uri});
  } catch (e) {
    ssmlBuilder.add('But Spotify is not active. Activate it and try again.')
  }
  conv.askSsml(ssmlBuilder);
  conv.close();
});

function listNextItems(conv: Conversation) {
  extendListFollowupContextLifespan(conv.contexts);
  conv.data.list.offset += conv.data.list.limit;
  conv.listItemNames();
  conv.addListSuggestions();
}

app.intent('list - more', listNextItems);
app.intent('list - next', listNextItems);

app.intent('list - previous', function listPreviousItems(conv: Conversation) {
  extendListFollowupContextLifespan(conv.contexts);
  const {limit, offset} = conv.data.list;
  conv.data.list.offset = Math.max(0, offset - limit);
  conv.listItemNames();
  conv.addListSuggestions();
});

function listCurrentItems(conv: Conversation) {
  extendListFollowupContextLifespan(conv.contexts);
  conv.listItemNames();
  conv.addListSuggestions();
}

app.intent('list - repeat', listCurrentItems);

app.intent('retry', async conv => {
  const ssmlBuilder = new SsmlBuilder();
  const selectedListItem = conv.user.storage.selectedListItem;
  if (!selectedListItem) {
    ssmlBuilder.add(`Nothing has been selected yet.`);
  } else {
    try {
      await conv.spotify.play({context_uri: selectedListItem.uri});
      ssmlBuilder.add(`Playing ${escapeHtml(selectedListItem.name)}.`);
    } catch (e) {
      ssmlBuilder.add('Spotify is not active. Activate it and try again.')
    }
  }
  conv.askSsml(ssmlBuilder);
  conv.close();
});

app.intent('actions_intent_NO_INPUT', conv => {
  if (conv.arguments.get('IS_FINAL_REPROMPT')) {
    conv.close(`Okay let's try this again later.`);
  } else if (conv.data.items) {
    listCurrentItems(conv);
  } else {
    welcome(conv);
  }
});

async function getPlaylists(spotify: SpotifyWebApi): Promise<ListItem[]> {
  const result: ListItem[] = [];
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

app.intent('Goodbye', conv => {
  conv.close('See you later!')
});

app.intent('Default Fallback Intent', conv => {
  conv.ask(`I didn't understand. Can you tell me something else?`)
});

exports.fulfillment = functions.https.onRequest(app);
