{-# LANGUAGE RecordWildCards, NamedFieldPuns, ScopedTypeVariables, ConstraintKinds #-}

module Development.Shake.Internal.Core.Action(
    runAction, actionOnException, actionFinally,
    getShakeOptions, getProgress, runAfter,
    lintTrackRead, lintTrackWrite, lintTrackAllow, lintTrackFinished,
    getVerbosity, putWhen, putLoud, putNormal, putQuiet, withVerbosity, quietly,
    blockApply, unsafeAllowApply,
    traced
    ) where

import Control.Exception
import Control.Applicative
import Control.Monad.Extra
import Control.Monad.IO.Class
import Control.DeepSeq
import Data.Typeable.Extra
import Data.Function
import Data.Either.Extra
import Data.Maybe
import Data.IORef
import Data.List
import System.IO.Extra

import Development.Shake.Internal.Core.Database
import Development.Shake.Internal.Core.Monad
import Development.Shake.Internal.Core.Types
import Development.Shake.Internal.Value
import Development.Shake.Internal.Options
import Development.Shake.Internal.Errors
import General.Cleanup
import Prelude


---------------------------------------------------------------------
-- RAW WRAPPERS

runAction :: Global -> Local -> Action a -> Capture (Either SomeException a)
runAction g l (Action x) = runRAW g l x

-- | Apply a modification, run an action, then run an undo action after.
--   Doesn't actually require exception handling because we don't have the ability to catch exceptions to the user.
actionBracket :: (Local -> (Local, Local -> Local)) -> Action a -> Action a
actionBracket f m = Action $ do
    s <- getRW
    let (s2,undo) = f s
    putRW s2
    res <- fromAction m
    modifyRW undo
    return res


---------------------------------------------------------------------
-- EXCEPTION HANDLING

actionBoom :: Bool -> Action a -> IO b -> Action a
actionBoom runOnSuccess act clean = do
    Global{..} <- Action getRO
    undo <- liftIO $ addCleanup globalCleanup $ void clean
    -- important to mask_ the undo/clean combo so either both happen or neither
    res <- Action $ catchRAW (fromAction act) $ \e -> liftIO (mask_ $ undo >> clean) >> throwRAW e
    liftIO $ mask_ $ undo >> when runOnSuccess (void clean)
    return res

-- | If an exception is raised by the 'Action', perform some 'IO'.
actionOnException :: Action a -> IO b -> Action a
actionOnException = actionBoom False

-- | After an 'Action', perform some 'IO', even if there is an exception.
actionFinally :: Action a -> IO b -> Action a
actionFinally = actionBoom True


---------------------------------------------------------------------
-- QUERIES

-- | Get the initial 'ShakeOptions', these will not change during the build process.
getShakeOptions :: Action ShakeOptions
getShakeOptions = Action $ globalOptions <$> getRO


-- | Get the current 'Progress' structure, as would be returned by 'shakeProgress'.
getProgress :: Action Progress
getProgress = do
    Global{..} <- Action getRO
    liftIO globalProgress

-- | Specify an action to be run after the database has been closed, if building completes successfully.
runAfter :: IO () -> Action ()
runAfter op = do
    Global{..} <- Action getRO
    liftIO $ atomicModifyIORef globalAfter $ \ops -> (op:ops, ())


---------------------------------------------------------------------
-- VERBOSITY

putWhen :: Verbosity -> String -> Action ()
putWhen v msg = do
    Global{..} <- Action getRO
    verb <- getVerbosity
    when (verb >= v) $
        liftIO $ globalOutput v msg


-- | Write an unimportant message to the output, only shown when 'shakeVerbosity' is higher than normal ('Loud' or above).
--   The output will not be interleaved with any other Shake messages (other than those generated by system commands).
putLoud :: String -> Action ()
putLoud = putWhen Loud

-- | Write a normal priority message to the output, only supressed when 'shakeVerbosity' is 'Quiet' or 'Silent'.
--   The output will not be interleaved with any other Shake messages (other than those generated by system commands).
putNormal :: String -> Action ()
putNormal = putWhen Normal

-- | Write an important message to the output, only supressed when 'shakeVerbosity' is 'Silent'.
--   The output will not be interleaved with any other Shake messages (other than those generated by system commands).
putQuiet :: String -> Action ()
putQuiet = putWhen Quiet


-- | Get the current verbosity level, originally set by 'shakeVerbosity'. If you
--   want to output information to the console, you are recommended to use
--   'putLoud' \/ 'putNormal' \/ 'putQuiet', which ensures multiple messages are
--   not interleaved. The verbosity can be modified locally by 'withVerbosity'.
getVerbosity :: Action Verbosity
getVerbosity = Action $ localVerbosity <$> getRW


-- | Run an action with a particular verbosity level.
--   Will not update the 'shakeVerbosity' returned by 'getShakeOptions' and will
--   not have any impact on 'Diagnostic' tracing.
withVerbosity :: Verbosity -> Action a -> Action a
withVerbosity new = actionBracket $ \s0 ->
    (s0{localVerbosity=new}, \s -> s{localVerbosity=localVerbosity s0})


-- | Run an action with 'Quiet' verbosity, in particular messages produced by 'traced'
--   (including from 'Development.Shake.cmd' or 'Development.Shake.command') will not be printed to the screen.
--   Will not update the 'shakeVerbosity' returned by 'getShakeOptions' and will
--   not turn off any 'Diagnostic' tracing.
quietly :: Action a -> Action a
quietly = withVerbosity Quiet


---------------------------------------------------------------------
-- BLOCK APPLY

unsafeAllowApply :: Action a -> Action a
unsafeAllowApply  = applyBlockedBy Nothing

blockApply :: String -> Action a -> Action a
blockApply = applyBlockedBy . Just

applyBlockedBy :: Maybe String -> Action a -> Action a
applyBlockedBy reason = actionBracket $ \s0 ->
    (s0{localBlockApply=reason}, \s -> s{localBlockApply=localBlockApply s0})


---------------------------------------------------------------------
-- TRACING

-- | Write an action to the trace list, along with the start/end time of running the IO action.
--   The 'Development.Shake.cmd' and 'Development.Shake.command' functions automatically call 'traced'.
--   The trace list is used for profile reports (see 'shakeReport').
--
--   By default 'traced' prints some useful extra context about what
--   Shake is building, e.g.:
--
-- > # traced message (for myobject.o)
--
--   To suppress the output of 'traced' (for example you want more control
--   over the message using 'putNormal'), use the 'quietly' combinator.
traced :: String -> IO a -> Action a
traced msg act = do
    Global{..} <- Action getRO
    Local{localStack} <- Action getRW
    start <- liftIO globalTimestamp
    putNormal $ "# " ++ msg ++ " (for " ++ showTopStack localStack ++ ")"
    res <- liftIO act
    stop <- liftIO globalTimestamp
    let trace = newTrace msg start stop
    liftIO $ evaluate $ rnf trace
    Action $ modifyRW $ \s -> s{localTraces = trace : localTraces s}
    return res


---------------------------------------------------------------------
-- TRACKING

-- | Track that a key has been used/read by the action preceeding it when 'shakeLint' is active.
lintTrackRead :: ShakeValue key => [key] -> Action ()
-- One of the following must be true:
-- 1) you are the one building this key (e.g. key == topStack)
-- 2) you have already been used by apply, and are on the dependency list
-- 3) someone explicitly gave you permission with trackAllow
-- 4) at the end of the rule, a) you are now on the dependency list, and b) this key itself has no dependencies (is source file)
lintTrackRead ks = do
    Global{..} <- Action getRO
    when (isJust $ shakeLint globalOptions) $ do
        l@Local{..} <- Action getRW
        deps <- liftIO $ concatMapM (listDepends globalDatabase) localDepends
        let top = topStack localStack

        let condition1 k = top == Just k
        let condition2 k = k `elem` deps
        let condition3 k = any ($ k) localTrackAllows
        let condition4 = filter (\k -> not $ condition1 k || condition2 k || condition3 k) $ map newKey ks
        unless (null condition4) $
            Action $ putRW l{localTrackUsed = condition4 ++ localTrackUsed}


lintTrackFinished :: Action ()
lintTrackFinished = do
    Global{..} <- Action getRO
    when (isJust $ shakeLint globalOptions) $ do
        Local{..} <- Action getRW
        liftIO $ do
            deps <- concatMapM (listDepends globalDatabase) localDepends

            -- check 4a
            bad <- return $ localTrackUsed \\ deps
            unless (null bad) $ do
                let n = length bad
                errorStructured
                    ("Lint checking error - " ++ (if n == 1 then "value was" else show n ++ " values were") ++ " used but not depended upon")
                    [("Used", Just $ show x) | x <- bad]
                    ""

            -- check 4b
            bad <- flip filterM localTrackUsed $ \k -> not . null <$> lookupDependencies globalDatabase k
            unless (null bad) $ do
                let n = length bad
                errorStructured
                    ("Lint checking error - " ++ (if n == 1 then "value was" else show n ++ " values were") ++ " depended upon after being used")
                    [("Used", Just $ show x) | x <- bad]
                    ""


-- | Track that a key has been changed/written by the action preceding it when 'shakeLint' is active.
lintTrackWrite :: ShakeValue key => [key] -> Action ()
-- One of the following must be true:
-- 1) you are the one building this key (e.g. key == topStack)
-- 2) someone explicitly gave you permission with trackAllow
-- 3) this file is never known to the build system, at the end it is not in the database
lintTrackWrite ks = do
    Global{..} <- Action getRO
    when (isJust $ shakeLint globalOptions) $ do
        Local{..} <- Action getRW
        let top = topStack localStack

        let condition1 k = Just k == top
        let condition2 k = any ($ k) localTrackAllows
        let condition3 = filter (\k -> not $ condition1 k || condition2 k) $ map newKey ks
        unless (null condition3) $
            liftIO $ atomicModifyIORef globalTrackAbsent $ \old -> ([(fromMaybe k top, k) | k <- condition3] ++ old, ())


-- | Allow any matching key to violate the tracking rules.
lintTrackAllow :: ShakeValue key => (key -> Bool) -> Action ()
lintTrackAllow (test :: key -> Bool) = do
    Global{..} <- Action getRO
    when (isJust $ shakeLint globalOptions) $
        Action $ modifyRW $ \s -> s{localTrackAllows = f : localTrackAllows s}
    where
        tk = typeRep (Proxy :: Proxy key)
        f k = typeKey k == tk && test (fromKey k)
